import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep, toOut } from './cpath';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { runGit } from './git/exec';
import { IgnoreCache, LS_IGNORED_ARGS } from './git/ignore-cache';
import { gitSnapshotKey } from './git/snapshot-key';
import { LastSent } from './last-sent';
import { IPC } from '@shared/api';
import { shouldPrune } from '@shared/attribution';
import type { MergeInfo, RepoStatus } from '@shared/git';
import type { ScmEvent } from '@shared/scm';
import { headTarget } from './git-head';
import { discoverRepos, listWorkingTrees, type WorkingTree } from './git/repos';
import { StatusScheduler, buildFileIndex, readHeadContent, readRepoStatus } from './git/service';
import { testMs } from './dev-env';
import { Debouncer, classifyChange, gitChangeScope, gitDirOf, insideKind, locate, repoOf, scmChange, worktreeListChange } from './git/watch';
import { mergeAgainst, probeDefaultRef, readCompare, readContentAt } from './git/compare';
import { MergeSummaries } from './git/merge-cache';
import { KeepSet } from './git/keep-set';
import { filesReadSchema, gitBaseSchema } from './ipc-schemas';
import type { DaemonClient } from './daemon-client';
import { isBelow, isInside } from '@shared/paths';

/** The debouncer's key for "events were dropped": no path is ever this (a NUL can't be in a file name). */
const RESCAN = '\0rescan';

/** The status reader, its answer held back `ms` once read (tests only: devEnv). */
const slowRead = (ms: number | undefined) => (ms ? async (repo: string) => { const st = await readRepoStatus(repo); await new Promise((r) => setTimeout(r, ms)); return st; } : readRepoStatus);

interface Project {
  key: string; index?: { at: number; files: Promise<{ path: string; rel: string }[]> }; root: string;
  /** Repos found by the folder scan (⌘K's file index and Source Control's switcher build on them). */
  discovered: string[];
  /** Every working tree shown: the discovered repos plus their linked worktrees inside the project. */
  repos: string[];
  trees: Map<string, WorkingTree>;
  /** What each working tree's branch has to merge, for repos with linked worktrees. */
  merge: Map<string, MergeInfo | null>;
  relisting: Promise<void> | null; relistAgain: boolean;
  /** Its working trees were listed once: until then a status neither prunes nor counts as the last HEAD seen. */
  listed: boolean;
  status: Map<string, RepoStatus>; watcher: FSWatcher | null; debounce: Debouncer; windows: Set<WebContents>;
  /**
   * Common dirs outside the project, watched on their own: the project is (or holds) a linked worktree of a repository
   * elsewhere, whose refs, HEAD and index live there (a commit or a push changes no file of the project).
   */
  outside: Map<string, { watcher: FSWatcher; debounce: Debouncer }>
}

/**
 * How a status prunes attributions: whether it does, the nested repos it leaves alone, and the files Atelier's own ops
 * hold, pruned as if still dirty.
 */
export interface StatusPrune { prune: boolean; exclude: string[]; keep?: string[] }

export class GitHub {
  private projects = new Map<string, Project>();
  /** What git ignores per repo, and the last snapshot each project's windows got. */
  // What git ignores changed (a path un-ignored, or a skipped change that is no longer ignored): a fresh status.
  private readonly ignores = new IgnoreCache((repo) => runGit(repo, LS_IGNORED_ARGS, { timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 }),
    Date.now, (repo) => this.scheduler.request(repo));
  private readonly sent = new LastSent();
  // e2e: a status read as slow as on a Windows PC (seconds), to prove nothing on screen waits for it.
  private scheduler = new StatusScheduler(slowRead(testMs('ATELIER_TEST_STATUS_DELAY_MS')));
  /** What each working tree's branch has to merge, recomputed only when HEAD or the default branch moved. */
  private merges = new MergeSummaries(probeDefaultRef, mergeAgainst);
  /** HEAD of each repo at its last complete status. */
  private heads = new Map<string, string | null>();
  /** Files whose attributions survive prunes while an Atelier op holds them. */
  private readonly kept = new KeepSet();
  /** Working trees whose next read from that time on is sent whatever the dedup says (requestStatus). */
  private readonly forced = new Map<string, number>();
  /** Every new status of a repo, with whether it prunes attributions (the app-side Bash ones follow the same rule). */
  onStatus: (st: RepoStatus, o: StatusPrune) => void = () => {};
  /** Source Control: refs, a HEAD or a fetch changed in a .git folder of the project. */
  onScm: (projectRoot: string, e: ScmEvent, worktree: boolean) => void = () => {};
  /** A project's last window closed. */
  onProjectClosed: (projectRoot: string) => void = () => {};

  constructor(private readonly client: DaemonClient) {
    this.scheduler.onResult((st) => {
      // Files that became clean lose their attribution, but only once HEAD moved (commit, checkout): a brief clean
      // state with the same HEAD (stash, stash pop, reset) must not wipe them. An incomplete status (error,
      // truncated list) neither prunes nor counts as the last HEAD seen.
      // A project still listing its worktrees can't exclude them yet: its repo's prune waits for the next status.
      const waiting = [...this.projects.values()].some((p) => !p.listed && p.repos.includes(st.root));
      const prune = !waiting && shouldPrune(this.heads.get(st.root), st);
      if (!waiting && !st.error && st.truncated === 0) this.heads.set(st.root, st.oid);
      const nested = new Set<string>();
      const keep = this.kept.paths(st.root);
      // A read asked for after an Atelier write (started at or after the ask): sent even if nothing changed.
      const asked = this.forced.get(st.root);
      const force = asked !== undefined && st.checkedAt >= asked;
      if (force) this.forced.delete(st.root);
      for (const p of this.projects.values()) {
        if (!p.repos.includes(st.root)) continue;
        // A worktree whose folder is gone though no event said so (macOS drops events under a flood of writes).
        if (st.error && p.trees.get(st.root)?.worktreeOf && !existsSync(st.root)) this.relist(p);
        p.status.set(st.root, st);
        this.broadcast(p, force);
        this.refreshMerge(p, st);
        // Not for nested repos (they have their own status) and not for what was written after the read started.
        const exclude = p.repos.filter((r) => r !== st.root && isBelow(st.root, r));
        for (const r of exclude) nested.add(r);
        if (!prune) continue;
        const dirty = KeepSet.withKept(st.changes.map((c) => c.path), keep);
        void this.client.request({ t: 'attrPrune', root: st.root, dirty, exclude, before: st.checkedAt }).catch(() => {});
      }
      this.onStatus(st, { prune, exclude: [...nested], keep });
    });
  }

  /**
   * Keeps the attributions of `paths` (absolute, or relative to the working tree `root`) through every prune of that
   * root until the answered release is called (any number of times). Several holders may keep the same file.
   */
  keep(root: string, paths: string[]): () => void {
    return this.kept.hold(root, paths);
  }

  open(root: string, wc: WebContents): void {
    let p = this.projects.get(root);
    if (!p) {
      // Real paths everywhere, like those of git and attributions (e.g. /var → /private/var).
      let real = root;
      try { real = toOut(realpathSync(root)); } catch { /* folder gone */ }
      const discovered = discoverRepos(real);
      const proj: Project = {
        key: root, root: real, discovered, repos: [...discovered], trees: new Map(), merge: new Map(), relisting: null, relistAgain: false, listed: false,
        status: new Map(), watcher: null, windows: new Set(), debounce: new Debouncer(300, (keys) => this.onChanges(proj, keys), 1500), outside: new Map()
      };
      try {
        // Ignored paths (node_modules, .git objects) are dropped right away: during an npm install there are thousands.
        // No name: the OS dropped events (Windows' change buffer overflows under an install or a build): every working
        // tree is read again, or what changed meanwhile would stay unseen until some later event.
        proj.watcher = watch(real, { recursive: true }, (_ev, file) => {
          if (!file) proj.debounce.add(RESCAN);
          else if (classifyChange(real, String(file)) !== 'ignore') proj.debounce.add(String(file));
        });
        proj.watcher.on('error', () => { /* folder gone: the status stays the last known one */ });
      } catch { /* without a watcher it only updates on hook events */ }
      p = proj;
      this.projects.set(root, p);
      for (const r of discovered) this.scheduler.request(r);
      for (const r of discovered) void this.ignores.refresh(r);
      // The repos show at once; their linked worktrees join as soon as git lists them.
      this.relist(proj);
    }
    p.windows.add(wc);
    wc.once('destroyed', () => this.close(root, wc));
  }

  /** The repos of a project a window has open (real paths); none otherwise. */
  reposOf(root: string): string[] {
    return this.projects.get(root)?.repos ?? [];
  }

  /** A project's real root, its working trees and discovered repos, their last statuses and its windows (Source Control builds on them). */
  info(root: string): { root: string; repos: string[]; discovered: string[]; status: ReadonlyMap<string, RepoStatus>; windows: ReadonlySet<WebContents>; trees?: readonly WorkingTree[] } | null {
    const p = this.projects.get(root);
    // The working trees once listed: Source Control's switcher shows the same ones as Changes.
    return p ? { root: p.root, repos: p.repos, discovered: p.discovered, status: p.status, windows: p.windows, ...(p.listed && p.trees.size ? { trees: [...p.trees.values()] } : {}) } : null;
  }

  /** Lists the project's working trees again (a worktree added or removed): new ones get a status, gone ones leave. */
  private relist(p: Project): void {
    if (p.relisting) { p.relistAgain = true; return; }
    p.relisting = listWorkingTrees(p.root, p.discovered, [...p.trees.values()]).then((trees) => {
      if (this.projects.get(p.key) !== p) return;
      const before = new Set(p.repos);
      const first = !p.listed;
      p.listed = true;
      p.trees = new Map(trees.map((t) => [t.root, t]));
      p.repos = trees.map((t) => t.root);
      // The first listing: every repo again, so a prune held back meanwhile happens with its worktrees excluded.
      for (const r of p.repos) if (first || !before.has(r) || this.sharesCommon(p, r)) this.scheduler.request(r);
      for (const r of before) if (!p.trees.has(r)) { p.status.delete(r); p.merge.delete(r); this.merges.forget(r); }
      // A repo whose last worktree went has no merge summary any more.
      for (const r of p.repos) if (p.merge.has(r) && !this.sharesCommon(p, r)) { p.merge.delete(r); this.merges.forget(r); }
      this.watchOutside(p);
      this.broadcast(p);
    }, () => {
      // Listed again on the next change; meanwhile statuses prune as before.
      if (!p.listed) { p.listed = true; for (const r of p.repos) this.scheduler.request(r); }
    }).finally(() => {
      p.relisting = null;
      if (p.relistAgain) { p.relistAgain = false; this.relist(p); }
    });
  }

  /** Watches the common dirs of the project's working trees that lie outside it; lets go of the ones no tree has now. */
  private watchOutside(p: Project): void {
    const commons = new Set([...p.trees.values()].map((t) => t.common).filter((c) => !isInside(p.root, c)));
    for (const [common, w] of p.outside) if (!commons.has(common)) { w.watcher.close(); w.debounce.dispose(); p.outside.delete(common); }
    for (const common of commons) {
      if (p.outside.has(common)) continue;
      const debounce = new Debouncer(300, (files) => this.onOutside(p, common, files), 1500);
      try {
        const watcher = watch(common, { recursive: true }, (_ev, file) => {
          if (!file) p.debounce.add(RESCAN);
          else if (classifyChange(p.root, `.git/${String(file)}`) !== 'ignore') debounce.add(String(file));
        });
        watcher.on('error', () => { /* gone: statuses stay the last known ones until the next listing */ });
        p.outside.set(common, { watcher, debounce });
      } catch { debounce.dispose(); /* not watchable: statuses follow file changes only */ }
    }
  }

  /** Paths changed in a common dir outside the project (relative to it). */
  private onOutside(p: Project, common: string, files: Set<string>): void {
    if (this.projects.get(p.key) !== p) return;
    const out = { repos: new Set<string>(), relist: false };
    for (const file of files) {
      const at = locate(`.git/${file}`);
      // A submodule of that repository has its own git dir under it.
      if (at) this.gitDirChanged(p, join(common, ...at.gitDir.split('/').slice(1)), `.git/${file}`, out);
    }
    for (const r of out.repos) this.scheduler.request(r);
    if (out.relist) this.relist(p);
  }

  /**
   * A path changed in the git dir `gitDir` (a real path; `rel` the path as locate reads it): the working trees it moves
   * get a fresh status — refs and fetches every tree of that common dir, a linked worktree's admin files that worktree,
   * the main HEAD and index the main checkout — merge summaries are worked out again when refs moved, the worktrees are
   * listed again when one may have come or gone, and Source Control hears of it.
   */
  private gitDirChanged(p: Project, gitDir: string, rel: string, out: { repos: Set<string>; relist: boolean }): void {
    const at = locate(rel);
    if (!at || insideKind(at.inside) === 'ignore') return;
    let dir = gitDir;
    try { dir = toOut(realpathSync(gitDir)); } catch { /* gone meanwhile */ }
    if (worktreeListChange(rel)) out.relist = true;
    const scope = gitChangeScope(rel);
    const trees = [...p.trees.values()].filter((t) => t.common === dir);
    if (scope === 'all') {
      // Refs moved (a commit, a branch deleted with its worktree): the worktrees are listed again too, so a removal
      // whose own events were lost is caught at the next one.
      this.merges.invalidate(dir);
      out.relist = true;
      for (const t of trees) out.repos.add(t.root);
    } else if (scope === 'linked') {
      const own = join(dir, 'worktrees', at.inside[1] ?? '');
      // A worktree's own admin folder when known, else every linked one (a tree whose .git file is unreadable).
      for (const t of trees) if (t.gitDir ? t.gitDir === own : t.worktreeOf || t.hidden) out.repos.add(t.root);
    } else if (scope === 'own') {
      for (const t of p.trees.values()) if (t.gitDir === dir) out.repos.add(t.root);
    }
    const scm = scmChange(rel);
    if (scm) this.onScm(p.key, { common: dir, what: scm.what }, scm.worktree);
  }

  /** Whether a working tree belongs to a repo with linked worktrees (its branch's merge summary is shown). */
  private sharesCommon(p: Project, root: string): boolean {
    const common = p.trees.get(root)?.common;
    if (!common) return false;
    let n = 0;
    for (const t of p.trees.values()) if (t.common === common && ++n > 1) return true;
    return false;
  }

  /** After a status: what the branch has to merge, for repos with linked worktrees; broadcast once known. */
  private refreshMerge(p: Project, st: RepoStatus): void {
    const common = p.trees.get(st.root)?.common;
    if (!common || !this.sharesCommon(p, st.root)) { p.merge.delete(st.root); return; }
    void this.merges.summary(common, st.root, st).then(({ info }) => {
      if (p.status.get(st.root) !== st) return;
      const prev = p.merge.get(st.root);
      p.merge.set(st.root, info);
      if (JSON.stringify(prev ?? null) !== JSON.stringify(info)) this.broadcast(p);
    });
  }

  /** The statuses a window gets: each working tree's, with its worktree link and merge summary. */
  private snapshot(p: Project): RepoStatus[] {
    return p.repos.map((r) => p.status.get(r)).filter((s): s is RepoStatus => !!s)
      .map((s) => ({ ...s, worktreeOf: p.trees.get(s.root)?.worktreeOf ?? null, merge: p.merge.get(s.root) ?? null }));
  }

  /** A fresh status of every repo of every open project (the attribution baseline after (re)connecting to atelierd). */
  refreshAll(): void {
    for (const p of this.projects.values()) for (const r of p.repos) this.scheduler.request(r);
  }

  /**
   * A fresh status of one working tree (after an Atelier git write in it), whichever projects show it: soon, the user
   * is waiting on that click (the spacing between reads is for bursts of file events). The first read that starts from
   * now on is sent even when equal to the last snapshot: the windows show what the write left until it comes.
   */
  requestStatus(root: string): void {
    if (![...this.projects.values()].some((p) => p.repos.includes(root))) return;
    if (!this.forced.has(root)) this.forced.set(root, Date.now());
    this.scheduler.request(root, { soon: true });
  }

  /** The windows of every project that shows this working tree (a git write's events go to them). */
  windowsShowing(root: string): WebContents[] {
    const out = new Set<WebContents>();
    for (const p of this.projects.values()) if (p.repos.includes(root)) for (const wc of p.windows) out.add(wc);
    return [...out];
  }

  /** A file touched by Claude (hook): update its repo right away, without waiting for the watcher. */
  touched(path: string): void {
    for (const p of this.projects.values()) {
      const r = repoOf(p.repos, path);
      if (r) this.scheduler.request(r);
    }
  }

  private onChanges(p: Project, rels: Set<string>): void {
    if (rels.has(RESCAN)) {
      rels.delete(RESCAN);
      for (const r of p.repos) this.scheduler.request(r);
      // Refs may have moved unseen too: History, the switcher and merge summaries read again, the worktrees listed.
      for (const common of new Set([...p.trees.values()].map((t) => t.common))) {
        this.merges.invalidate(common);
        this.onScm(p.key, { common, what: 'refs' }, true);
      }
      this.relist(p);
    }
    const out = { repos: new Set<string>(), relist: false };
    const { repos } = out;
    const files: string[] = [];
    for (const rel of rels) {
      const kind = classifyChange(p.root, rel);
      if (kind === 'ignore') continue;
      const abs = join(p.root, rel);
      // A linked worktree's HEAD, index and refs live in its main repo's .git, a submodule's in .git/modules: a commit
      // inside one changes no file of its folder.
      const gitDir = kind === 'git' ? gitDirOf(rel) : null;
      if (gitDir) this.gitDirChanged(p, join(p.root, gitDir), rel, out);
      const r = repoOf(p.repos, abs);
      if (r) {
        const relInRepo = relative(r, abs).split(sep).join('/');
        // A .gitignore changed: what git ignores changed.
        if (relInRepo === '.gitignore' || relInRepo.endsWith('/.gitignore')) void this.ignores.refresh(r, true);
        // A change git ignores (build output, logs) needs no status; an open editor tab still hears of it below.
        const skip = kind === 'file' && this.ignores.ignored(r, relInRepo);
        if (!skip) repos.add(r);
        // A new ignored folder (a first build) is learnt at the next listing: at most one per minute.
        if (kind === 'file' && this.ignores.stale(r)) void this.ignores.refresh(r);
      }
      if (kind === 'file') files.push(abs);
    }
    for (const r of repos) this.scheduler.request(r);
    if (out.relist) this.relist(p);
    if (files.length) for (const wc of p.windows) if (!wc.isDestroyed()) wc.send(IPC.evFsChanged, files);
  }

  private broadcast(p: Project, force = false): void {
    const repos = this.snapshot(p);
    // The same snapshot again changes nothing in the windows, unless a window waits for that read.
    if (!this.sent.changed(`git:${p.key}`, gitSnapshotKey(repos)) && !force) return;
    for (const wc of p.windows) if (!wc.isDestroyed()) wc.send(IPC.evGit, repos);
  }

  private close(root: string, wc: WebContents): void {
    const p = this.projects.get(root);
    if (!p) return;
    p.windows.delete(wc);
    // Gone with its last window: reopened, its first snapshot must reach the new window even if equal to the old one.
    if (p.windows.size === 0) {
      p.watcher?.close(); p.debounce.dispose();
      for (const w of p.outside.values()) { w.watcher.close(); w.debounce.dispose(); }
      p.outside.clear();
      this.projects.delete(root); this.sent.forget(`git:${p.key}`); this.onProjectClosed(root);
    }
  }

  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean): void {
    const proj = (e: IpcMainInvokeEvent) => {
      const r = projectOf(e.sender.id);
      if (!r || !isTrusted(e)) throw new Error('unauthorized sender');
      return this.projects.get(r) ?? null;
    };
    // File index for ⌘K: recomputed at most every 15 s.
    ipcMain.handle(IPC.filesIndex, (e) => {
      const p = proj(e);
      if (!p) return [];
      // The discovered repos only: a linked worktree's files are copies of its repo's (⌘K would list each twice).
      if (!p.index || Date.now() - p.index.at > 15000) p.index = { at: Date.now(), files: buildFileIndex(p.root, p.discovered) };
      return p.index.files;
    });
    ipcMain.handle(IPC.gitStatus, (e) => {
      const p = proj(e);
      return p ? this.snapshot(p) : [];
    });
    ipcMain.handle(IPC.gitHead, async (e, arg) => {
      const p = proj(e);
      const path = filesReadSchema.parse(arg);
      const target = p ? headTarget(p.root, p.repos, path) : null;
      if (!target) return { original: null };
      return { original: await readHeadContent(target.repo, target.rel) };
    });
    // Review: the base side at HEAD or at a merge base (a full commit id, checked by the schema).
    ipcMain.handle(IPC.gitBase, async (e, arg) => {
      const p = proj(e);
      const { path, rev } = gitBaseSchema.parse(arg);
      const target = p ? headTarget(p.root, p.repos, path) : null;
      if (!target) return { original: null };
      return { original: await readContentAt(target.repo, rev, target.rel) };
    });
    // Each repo against its default branch, from its last status (repos without one yet are skipped).
    ipcMain.handle(IPC.gitCompare, async (e) => {
      const p = proj(e);
      if (!p) return [];
      return Promise.all(p.repos.map((r) => p.status.get(r)).filter((s): s is RepoStatus => !!s).map((s) => readCompare(s.root, s)));
    });
  }
}
