// The store's git slice, spread into useApp: the commit drawer and its target, drafts, the ops
// running now, each working tree's last result, the git sheets, Commit all, and main's facts per root.
import type { RepoStatus } from '@shared/git';
import type { GitFacts, GitOp, GitOpEvent, GitOpResult, RemoteCommit, StageTarget, SyncAllRow } from '@shared/git-write';
import type { AppState } from '../store';
import { applyIntents, settleIntents, type StageIntent } from './stage-intents';
import { applySync, freshEntries, settleSync, syncIntentOf, syncRefs, type SyncIntent } from './sync-intents';
import type { CommitAllCard, CommitAllState } from './commit-all';
import { loadGitDrafts, saveDrawerHeight, saveGitDraft } from './drafts';
import { toggleUnfold } from './fold';
import type { GitWrite } from './message';
import { defaultTarget } from './target';
import { isAbsPath } from '@shared/paths';

/**
 * A fast-forward pull or a sync main refused because the branch diverged: the window that ran it asks to rebase
 * (git/actions.ts). Only a pull or sync without rebase answers this.
 */
export function divergedRefusal(op: GitOp, r: GitOpResult): boolean {
  if (op === 'pull') return r.outcome === 'error' && /fast-forward/i.test(r.message ?? '');
  return op === 'sync' && r.outcome === 'state' && /diverged/i.test(r.message ?? '');
}

/** The drawer: open, its height dragged by hand (null: natural), groups unfolded by hand, what it was opened for. */
export interface GitDrawer { open: boolean; height: number | null; unfolded: string[]; openedFor: { root: string } | { session: string } | null }

/** A working tree's last result: a commit (with its Undo while main offers it), or a failure not looked at yet. */
export type GitResultEntry =
  | { sha: string; at: number; undo: { oid: string } | null }
  | { failed: GitOpResult; op: GitOp; at: number; seen: boolean };

/** Every git sheet (one at a time). */
export type GitSheet =
  | { kind: 'publish'; root: string }
  | { kind: 'rejected'; root: string }
  /** total: how many commits the remote has that HEAD lacks (`commits` lists the first ones). */
  | { kind: 'forcePush'; root: string; commits: RemoteCommit[]; total: number; remoteOid: string }
  /** byResult: opened by git's refusal (not a click): the safe button takes the focus. */
  | { kind: 'pullRebase'; root: string; sync: boolean; byResult?: true }
  | { kind: 'pullOverlap'; root: string; files: string[]; rebase: boolean; sync: boolean }
  /** clash: the files git refused to carry over (Switch and bring my changes). */
  | { kind: 'switch'; root: string; ref: string; clash?: string[] }
  | { kind: 'newBranch'; root: string; from?: string }
  | { kind: 'deleteBranch'; root: string; ref: string; message?: string }
  | { kind: 'worktree'; root: string; ref?: string }
  | { kind: 'stash'; root: string }
  | { kind: 'discard'; targets: { root: string; rels: StageTarget }[] }
  /** run: the list after Pull All or Push All (none: Sync All). */
  | { kind: 'syncAll'; rows: SyncAllRow[]; run?: 'pull' | 'push' };

export type { CommitAllCard, CommitAllState };

/** An op queued or running now, with the output it printed so far (capped to its tail). */
export type GitRunning = GitOpEvent & { output: string };
export const OP_OUTPUT_MAX = 64 * 1024;

export interface GitSlice {
  gitDrawer: GitDrawer;
  /** Opens the drawer on its default target; `root`: "Commit…" on a repository, `session`: on a session. */
  openGitDrawer(o?: { root?: string; session?: string }): void;
  closeGitDrawer(): void;
  setGitDrawerHeight(height: number | null): void;
  toggleGitUnfold(key: string): void;
  gitTarget: string | null;
  setGitTarget(root: string | null): void;
  /** The last file staged in this window (its path). */
  gitLastStaged: string | null;
  /** A file was staged here: remembered, and the target moves to its repository while the drawer is open. */
  noteStaged(root: string, path: string): void;
  /** Checkbox clicks shown before git and a status read show them (stage-intents.ts), in click order. */
  gitStageIntents: StageIntent[];
  /** The statuses as main last sent them: `repos` is them with the intents laid over. */
  gitReposSeen: RepoStatus[];
  /** A stage or unstage asked of main: shown at once. */
  addStageIntent(root: string, rels: StageTarget, to: 'all' | 'none'): number;
  /** Its answer: `at`, when git was done (shown until a read from then on comes in); null, it failed (shown no more). */
  endStageIntent(id: number, at: number | null): void;
  /** Main's statuses: the intents they show now go; Source Control's entries take the newer ones at once. */
  seeRepos(repos: RepoStatus[]): void;
  /** Pulls, pushes and syncs done, shown on every status read before them until one read since comes in (sync-intents.ts). */
  gitSyncIntents: SyncIntent[];
  /** One done: laid over Changes' statuses and Source Control's entries at once. */
  addSyncIntent(i: SyncIntent): void;
  /** The project's drafts, working tree root → message. */
  gitDrafts: Record<string, string>;
  setGitDraft(root: string, text: string): void;
  gitOps: Record<string, GitRunning>;
  /** When the latest op seen started: the drawer's result notice lasts until the next op. */
  gitActedAt: number;
  applyGitOp(e: GitOpEvent): void;
  gitResult: Record<string, GitResultEntry>;
  /**
   * `own: false`: an op seen through its event, maybe another window's. Its commit is not "Committed just now" here
   * (the picker; the result notice and its Undo): only this window's own answers record a sha.
   */
  recordGitResult(root: string, op: GitOp, r: GitOpResult, o?: { own?: boolean }): void;
  seeGitResult(root: string): void;
  /** The drawer's log dismissed: the root's failure goes (a commit's result stays). */
  dismissGitResult(root: string): void;
  gitSheet: GitSheet | null;
  setGitSheet(sheet: GitSheet | null): void;
  commitAll: CommitAllState | null;
  setCommitAll(state: CommitAllState | null): void;
  /** Commit all's run and streams change it in place: never closes the menu or palette (setCommitAll opening does). */
  updateCommitAll(fn: (state: CommitAllState) => CommitAllState): void;
  gitFacts: Record<string, GitFacts>;
  setGitFacts(root: string, facts: GitFacts | null): void;
  /** ✦ in the drawer: the target's run, writing or ready (message-run.ts drives it). */
  gitWrite: GitWrite | null;
  setGitWrite(w: GitWrite | null): void;
  /** The project's drafts and drawer height, when the window gets its project. */
  loadGitProject(project: string): void;
}

/** Failures of these stay on the bar until seen; the others answer with a toast or a sheet. */
const KEPT_FAILURES: ReadonlySet<GitOp> = new Set(['commit', 'push', 'pull', 'sync']);
const CLEAN_DRAWER: GitDrawer = { open: false, height: null, unfolded: [], openedFor: null };

export function createGitSlice(set: (p: Partial<AppState>) => void, get: () => AppState): GitSlice {
  const project = () => get().project?.root ?? null;
  let intentSeq = 0;
  /**
   * Main's statuses (`seen`, kept as sent) with the intents still to show laid over them: `repos` follows, in one
   * update (Source Control's entries too, when given).
   */
  const show = (seen: RepoStatus[], stage: StageIntent[], sync: SyncIntent[], extra: Partial<AppState> = {}) => {
    const kept = settleIntents(stage, seen);
    const laid = sync.length ? seen.map((r) => applySync(r.root, r, sync)) : seen;
    set({ gitReposSeen: seen, gitStageIntents: kept, gitSyncIntents: sync, repos: applyIntents(laid, kept), ...extra });
  };
  const showIntents = (seen: RepoStatus[], intents: StageIntent[]) => show(seen, intents, get().gitSyncIntents);
  /** No intent shown: `repos` is main's statuses as they are (set directly too, before any intent). */
  const base = () => { const st = get(); return st.gitStageIntents.length === 0 && st.gitSyncIntents.length === 0 ? st.repos : st.gitReposSeen; };
  const withResult = (root: string, entry: GitResultEntry | null) => {
    const { [root]: _old, ...rest } = get().gitResult;
    set({ gitResult: entry ? { ...rest, [root]: entry } : rest });
  };
  return {
    gitDrawer: CLEAN_DRAWER,
    openGitDrawer: (o = {}) => {
      const st = get();
      const active = isAbsPath(st.activeTab) ? st.activeTab : null;
      const target = defaultTarget({ openedFor: o.root ?? null, lastStaged: st.gitLastStaged, repos: st.repos, activeFile: active });
      const openedFor = o.root ? { root: o.root } : o.session ? { session: o.session } : null;
      set({ gitDrawer: { ...st.gitDrawer, open: true, unfolded: [], openedFor }, gitTarget: target });
    },
    closeGitDrawer: () => set({ gitDrawer: { ...get().gitDrawer, open: false, unfolded: [], openedFor: null } }),
    setGitDrawerHeight: (height) => {
      set({ gitDrawer: { ...get().gitDrawer, height } });
      const p = project();
      if (p) saveDrawerHeight(p, height);
    },
    toggleGitUnfold: (key) => set({ gitDrawer: { ...get().gitDrawer, unfolded: toggleUnfold(get().gitDrawer.unfolded, key) } }),
    gitTarget: null,
    setGitTarget: (gitTarget) => set({ gitTarget }),
    gitLastStaged: null,
    noteStaged: (root, path) => set({ gitLastStaged: path, ...(get().gitDrawer.open && get().gitTarget !== root ? { gitTarget: root } : {}) }),
    gitStageIntents: [],
    gitReposSeen: [],
    addStageIntent: (root, rels, to) => {
      const st = get();
      const id = ++intentSeq;
      showIntents(base(), [...st.gitStageIntents, { id, root, rels, to, at: null }]);
      return id;
    },
    endStageIntent: (id, at) => {
      const st = get();
      if (!st.gitStageIntents.some((i) => i.id === id)) return;
      showIntents(st.gitReposSeen, st.gitStageIntents.flatMap((i) => (i.id !== id ? [i] : at === null ? [] : [{ ...i, at }])));
    },
    seeRepos: (sent) => {
      const st = get();
      const sync = settleSync(st.gitSyncIntents, sent);
      const scm = st.scmRepos ? freshEntries(st.scmRepos, sent, sync) : null;
      show(sent, st.gitStageIntents, sync, scm !== st.scmRepos ? { scmRepos: scm } : {});
    },
    gitSyncIntents: [],
    addSyncIntent: (i) => {
      const st = get();
      const sync = [...st.gitSyncIntents, i];
      const refs = st.scmRefs[i.root];
      const laid = refs ? syncRefs(refs, i) : null;
      show(base(), st.gitStageIntents, sync, {
        ...(st.scmRepos ? { scmRepos: freshEntries(st.scmRepos, [], sync) } : {}),
        ...(laid && laid !== refs ? { scmRefs: { ...st.scmRefs, [i.root]: laid } } : {})
      });
    },
    gitDrafts: {},
    setGitDraft: (root, text) => {
      const { [root]: _old, ...rest } = get().gitDrafts;
      set({ gitDrafts: text.trim() ? { ...rest, [root]: text } : rest });
      const p = project();
      if (p) saveGitDraft(p, root, text);
    },
    gitOps: {},
    gitActedAt: 0,
    applyGitOp: (e) => {
      const { [e.id]: prev, ...rest } = get().gitOps;
      if (e.phase === 'done') {
        // What a pull, push or sync left shows as the busy state ends: never the counts from before it in between.
        const intent = syncIntentOf(e.root, e.result);
        if (intent) get().addSyncIntent(intent);
        set({ gitOps: rest });
        // Any window's op: a failure shows here too; a commit is this window's only from its own answer (own). A pull
        // or sync refused as diverged is the rebase sheet's question, never a failure kept on the bar.
        if (e.result && !divergedRefusal(e.op, e.result)) get().recordGitResult(e.root, e.op, e.result, { own: false });
        return;
      }
      const output = `${prev?.output ?? ''}${e.chunk ?? ''}`.slice(-OP_OUTPUT_MAX);
      const { chunk: _chunk, ...event } = e;
      if (!prev && e.startedAt > get().gitActedAt) set({ gitActedAt: e.startedAt });
      set({ gitOps: { ...rest, [e.id]: { ...prev, ...event, hook: e.hook ?? prev?.hook, output } as GitRunning } });
    },
    gitResult: {},
    recordGitResult: (root, op, r, o = {}) => {
      const cur = get().gitResult[root];
      if (r.outcome === 'ok') {
        if (op === 'commit' && r.sha) {
          if (cur && 'sha' in cur && cur.sha === r.sha) return;
          if (o.own === false) { if (cur && 'failed' in cur) withResult(root, null); return; }
          withResult(root, { sha: r.sha, at: Date.now(), undo: r.undo ?? null });
        } else if (op === 'undoCommit' || (cur && 'failed' in cur && KEPT_FAILURES.has(op))) {
          withResult(root, null);
        }
        return;
      }
      if (r.outcome === 'cancelled' || r.outcome === 'nothing' || !KEPT_FAILURES.has(op)) return;
      withResult(root, { failed: r, op, at: Date.now(), seen: false });
    },
    dismissGitResult: (root) => {
      const cur = get().gitResult[root];
      if (cur && 'failed' in cur) withResult(root, null);
    },
    seeGitResult: (root) => {
      const cur = get().gitResult[root];
      if (cur && 'failed' in cur && !cur.seen) withResult(root, { ...cur, seen: true });
    },
    gitSheet: null,
    setGitSheet: (gitSheet) => set({ gitSheet, ...(gitSheet ? { menu: null, paletteOpen: false, bgPopover: null } : {}) }),
    commitAll: null,
    setCommitAll: (commitAll) => set({ commitAll, ...(commitAll?.open ? { menu: null, paletteOpen: false, bgPopover: null } : {}) }),
    updateCommitAll: (fn) => { const cur = get().commitAll; if (cur) set({ commitAll: fn(cur) }); },
    gitFacts: {},
    setGitFacts: (root, facts) => {
      const { [root]: _old, ...rest } = get().gitFacts;
      set({ gitFacts: facts ? { ...rest, [root]: facts } : rest });
    },
    gitWrite: null,
    setGitWrite: (gitWrite) => set({ gitWrite }),
    loadGitProject: (p) => {
      const saved = loadGitDrafts(p);
      set({ gitDrafts: saved.drafts, gitDrawer: { ...get().gitDrawer, height: saved.height } });
    }
  };
}
