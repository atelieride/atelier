import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { RepoStatus } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import { checksUrl, prKey, type GhStatus, type PrEntry, type PrInfo, type PrsState } from '@shared/pr';
import { validBranch, type GhResult } from './github/exec';
import { repoOf } from './git/watch';
import { prOpenSchema } from './ipc-schemas';

/**
 * How often (ms): the scheduler's tick, a focus refresh's minimum age, the focused poll, the poll while checks run, and
 * the poll once the same answer came back REST_AFTER times running.
 */
export interface PrIntervals { tick: number; focus: number; poll: number; pending: number; rest: number }
export const PR_INTERVALS: PrIntervals = { tick: 5000, focus: 30000, poll: 60000, pending: 20000, rest: 300000 };
const REST_AFTER = 3;
const MAX_RUNNING = 2;
const DEFAULT_BRANCHES = new Set(['main', 'master']);

export interface PrDeps {
  /** `gh pr view <branch>` in that repo root (src/main/github/exec.ts). Never throws. */
  view(root: string, branch: string): Promise<GhResult>;
  /** Settings › Claude › Pull request and CI status. Off: gh never runs. */
  enabled(): boolean;
  /** Any Atelier window focused (hidden e2e windows count as focused). */
  focused(): boolean;
  /** The repos of a window's project (real paths, from git-hub). */
  reposOf(project: string): readonly string[];
  /** Real path of a folder (sessions may report /var/… where repos are /private/var/…). */
  realpath(p: string): string;
  intervals?: PrIntervals;
}

export interface PrWindow {
  id: number;
  send(channel: string, payload: PrsState): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): void;
}

type Known = { status: 'ok'; pr: PrInfo } | { status: 'none' | 'missing' | 'auth' };
interface CacheEntry { root: string; branch: string; known: Known | null; at: number; same: number }
interface Target { root: string; branch: string; key: string }

/**
 * Pull requests of the Claude sessions' branches. For each session: the deepest repo of its window's
 * project containing `session.cwd ?? terminal.cwd`, and that repo's branch (from git-hub's statuses); detached HEAD,
 * main/master or no repo: nothing. One cached result per repo+branch, asked again when the branch changes, on focus
 * when older than 30 s, every 60 s while focused, every 20 s while checks are pending; at most two gh at once, never
 * twice the same; only with the setting on. "No PR" → none; gh missing / not logged in → that status (Settings explains
 * it); any other failure keeps the last result.
 */
export class PrHub {
  private terminals: TerminalInfo[] = [];
  private branches = new Map<string, string | null>();
  /** Each root's head (oid, ahead, upstream): when it moves, the PR back-off ends. */
  private heads = new Map<string, string>();
  private cache = new Map<string, CacheEntry>();
  private queue: string[] = [];
  private inflight = new Set<string>();
  private gh: GhStatus = 'unknown';
  private windows = new Map<number, { wc: PrWindow; project: string; sent: string }>();
  private real = new Map<string, string>();
  private readonly iv: PrIntervals;
  private timer: NodeJS.Timeout;
  /** Bumped when the setting goes off: results of gh runs started before are dropped. */
  private epoch = 0;

  constructor(private readonly deps: PrDeps) {
    this.iv = deps.intervals ?? PR_INTERVALS;
    this.timer = setInterval(() => this.tick(), this.iv.tick);
    this.timer.unref?.();
  }

  open(project: string, wc: PrWindow): void {
    this.windows.set(wc.id, { wc, project, sent: JSON.stringify({ gh: 'unknown', terminals: {} }) });
    wc.once('destroyed', () => this.windows.delete(wc.id));
    this.broadcast();
  }

  /** atelierd's terminal list. */
  setTerminals(list: readonly TerminalInfo[]): void {
    this.terminals = [...list];
    this.update();
  }

  /** A new git status of a repo: its branch (null when detached or unknown). */
  repoStatus(st: RepoStatus): void {
    const branch = st.detached ? null : st.branch;
    // The branch moved (a push, a commit, a new upstream): its PR or checks may follow, so the rest pace ends.
    const head = `${st.oid ?? ''}|${st.ahead}|${st.upstream ?? ''}`;
    const was = this.heads.get(st.root);
    this.heads.set(st.root, head);
    if (was !== undefined && was !== head) for (const e of this.cache.values()) if (e.root === st.root) e.same = 0;
    if (this.branches.get(st.root) === branch) return;
    this.branches.set(st.root, branch);
    this.update();
  }

  /** A window gained focus: results older than 30 s are asked again. */
  refresh(): void {
    if (!this.deps.enabled()) return;
    const targets = this.targets();
    this.track(targets);
    for (const t of targets.values()) {
      const e = this.cache.get(t.key);
      if (!e || Date.now() - e.at >= this.iv.focus) this.enqueue(t.key);
    }
    this.pump();
  }

  /** Settings changed: off clears every window at once (and drops results in flight); on asks right away. */
  settingsChanged(): void {
    if (!this.deps.enabled()) {
      this.epoch++;
      this.cache.clear();
      this.queue = [];
      this.broadcast();
      return;
    }
    this.update();
  }

  stateOf(project: string): PrsState {
    const terminals: Record<string, PrEntry> = {};
    if (this.deps.enabled()) {
      for (const [id, t] of this.targets(project)) {
        const known = this.cache.get(t.key)?.known;
        if (known) terminals[id] = { root: t.root, branch: t.branch, ...known };
      }
    }
    return { gh: this.gh, terminals };
  }

  /** The URL a PR chip opens: only the https URL gh gave for a session's repo+branch of this project. */
  openTarget(project: string, root: string, branch: string, checks: boolean): string | null {
    const entry = Object.values(this.stateOf(project).terminals).find((e) => e.root === root && e.branch === branch);
    if (!entry || entry.status !== 'ok') return null;
    return checks ? checksUrl(entry.pr.url) : entry.pr.url;
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Each session terminal (of one project, or all) → its repo and branch, when there is something to ask gh. */
  private targets(project?: string): Map<string, Target> {
    const out = new Map<string, Target>();
    for (const t of this.terminals) {
      if (!t.session || (project !== undefined && t.projectRoot !== project)) continue;
      const root = repoOf([...this.deps.reposOf(t.projectRoot)], this.realOf(t.session.cwd ?? t.cwd));
      const branch = root ? this.branches.get(root) : null;
      if (!root || !branch || DEFAULT_BRANCHES.has(branch) || !validBranch(branch)) continue;
      out.set(t.id, { root, branch, key: prKey(root, branch) });
    }
    return out;
  }

  private realOf(p: string): string {
    let r = this.real.get(p);
    if (r === undefined) {
      try { r = this.deps.realpath(p); } catch { r = p; }
      if (this.real.size > 500) this.real.clear();
      this.real.set(p, r);
    }
    return r;
  }

  /** Terminals or branches changed: new repo+branch pairs are asked at once, unused ones forgotten. */
  private update(): void {
    if (!this.deps.enabled()) return;
    const targets = this.targets();
    const keys = new Set([...targets.values()].map((t) => t.key));
    for (const k of [...this.cache.keys()]) if (!keys.has(k) && !this.inflight.has(k)) this.cache.delete(k);
    this.track(targets);
    this.pump();
    this.broadcast();
  }

  /**
   * Pairs with no entry yet get one, asked at once. Not only on list/branch changes: a project window reopened on the
   * same branch brings its repos (and so its targets) back without either changing — refresh and tick catch it.
   */
  private track(targets: Map<string, Target>): void {
    for (const t of targets.values()) {
      if (!this.cache.has(t.key)) { this.cache.set(t.key, { root: t.root, branch: t.branch, known: null, at: 0, same: 0 }); this.enqueue(t.key); }
    }
  }

  private tick(): void {
    if (!this.deps.enabled() || !this.deps.focused()) return;
    const now = Date.now();
    const targets = this.targets();
    this.track(targets);
    for (const t of targets.values()) {
      const e = this.cache.get(t.key);
      if (!e) continue;
      const pending = e.known?.status === 'ok' && e.known.pr.ci.state === 'pending';
      // The same answer three times running: nothing is moving, ask less often (a focus still refreshes after 30 s).
      const every = pending ? this.iv.pending : e.same >= REST_AFTER ? this.iv.rest : this.iv.poll;
      if (now - e.at >= every) this.enqueue(t.key);
    }
    this.pump();
  }

  private enqueue(key: string): void {
    if (this.inflight.has(key) || this.queue.includes(key)) return;
    this.queue.push(key);
  }

  private pump(): void {
    while (this.inflight.size < MAX_RUNNING && this.queue.length) {
      const key = this.queue.shift()!;
      const e = this.cache.get(key);
      if (!e || this.inflight.has(key)) continue;
      this.inflight.add(key);
      const epoch = this.epoch;
      void this.deps.view(e.root, e.branch).then((r) => this.done(key, r, epoch), () => this.done(key, { kind: 'error' }, epoch));
    }
  }

  private done(key: string, r: GhResult, epoch: number): void {
    this.inflight.delete(key);
    if (epoch === this.epoch && this.deps.enabled()) {
      const e = this.cache.get(key);
      if (e) {
        e.at = Date.now();
        const before = JSON.stringify(e.known);
        if (r.kind === 'ok') e.known = { status: 'ok', pr: r.pr };
        else if (r.kind !== 'error') e.known = { status: r.kind };
        // A gh error (offline, rate limit) says nothing about the PR: it neither counts as the same answer nor resets it.
        if (r.kind !== 'error') e.same = JSON.stringify(e.known) === before ? e.same + 1 : 0;
      }
      if (r.kind === 'ok' || r.kind === 'none') this.gh = 'ok';
      else if (r.kind === 'missing' || r.kind === 'auth') this.gh = r.kind;
      this.broadcast();
    }
    this.pump();
  }

  private broadcast(): void {
    for (const w of this.windows.values()) {
      if (w.wc.isDestroyed()) continue;
      const payload = this.stateOf(w.project);
      const key = JSON.stringify(payload);
      if (key === w.sent) continue;
      w.sent = key;
      w.wc.send(IPC.evPrs, payload);
    }
  }

  /** prs:list (the window's project only) and pr:open: sender checked, strict schema, main-held https URL only. */
  installIpc(projectOf: (wcId: number) => string | null, isTrusted: (e: IpcMainInvokeEvent) => boolean, openUrl: (url: string) => Promise<boolean>): void {
    const project = (e: IpcMainInvokeEvent) => {
      const r = projectOf(e.sender.id);
      if (!r || !isTrusted(e)) throw new Error('unauthorized sender');
      return r;
    };
    ipcMain.handle(IPC.prsList, (e) => this.stateOf(project(e)));
    ipcMain.handle(IPC.prOpen, async (e, arg) => {
      const p = project(e);
      const { root, branch, checks } = prOpenSchema.parse(arg);
      const url = this.openTarget(p, root, branch, checks);
      return url ? openUrl(url) : false;
    });
  }
}
