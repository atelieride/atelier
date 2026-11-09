// git writes in the live demo. The visitor sees the whole commit flow and never
// commits:
// - staging is live: the checkboxes and menus stage and unstage in the fictional index (ctx.state.index), and Changes
//   hears the new status as main sends it, so the dots, the counts, the drawer's target and its button follow;
// - ✦ streams a canned message for what is staged (world/messages.ts), on the demo's clock;
// - every write that would change git (commit, push, pull, sync, branches, worktrees, stashes, discard) tells the shell
//   (notInDemo: "This one runs on your Mac. Download Atelier to try it.") and answers so the app stays quiet: cancelled,
//   which the renderer neither toasts nor keeps on the bar (actions.ts report, slice.ts recordGitResult). Discard's own
//   toast always shows (discardToast), so it answers ok in the demo's words; Sync All answers no repository, which the
//   app says is in sync (true of the fictional clone).
// Nothing runs git; the facts describe the world's repository on main, tracking origin/main, with an identity.
import type { RepoStatus } from '@shared/git';
import type { GitApi, GitFacts, GitOpResult, StageTarget } from '@shared/git-write';
import { COMMIT_MESSAGES, FALLBACK_MESSAGE } from '../world/messages';
import { noop, resolved, type DemoContext } from './context';
import { notInDemo } from './not-in-demo';

/** How far apart ✦'s three chunks come. */
export const MESSAGE_CHUNK_MS = 400;

/** A write the demo doesn't make: the renderer stays silent on cancelled (Commit all's row says it with these words). */
const NOT_HERE: GitOpResult = { outcome: 'cancelled', message: 'this runs on your Mac' };
/** Discard's answer: the app toasts main's message for an ok discard, as an info toast. */
const NOTHING_DISCARDED: GitOpResult = { outcome: 'ok', message: 'Nothing discarded: the demo keeps its files' };

/** What ✦ writes for these staged paths: one session's message, or several sessions' work under the first one's subject. */
export function demoMessage(staged: readonly string[], tweak?: 'shorter' | 'detail' | 'subject'): string {
  const touches = (paths: readonly string[]) => staged.some((rel) => paths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)));
  const work = COMMIT_MESSAGES.filter((m) => touches(m.paths));
  if (!work.length) return tweak === 'subject' || tweak === 'shorter' ? FALLBACK_MESSAGE.split('\n')[0]! : FALLBACK_MESSAGE;
  const subject = work[0]!.subject;
  if (tweak === 'subject') return subject;
  if (work.length === 1) return tweak === 'shorter' ? `${subject}\n\n${work[0]!.line}` : `${subject}\n\n${work[0]!.body}`;
  return tweak === 'shorter' ? subject : `${subject}\n\n${work.map((m) => `- ${m.line}`).join('\n')}`;
}

/** Three chunks at word boundaries, as `claude -p` streams them. */
function chunks(text: string): string[] {
  const cut = (from: number, near: number) => { const i = text.indexOf(' ', near); return i < 0 || i <= from ? text.length : i + 1; };
  const a = cut(0, Math.floor(text.length / 3));
  const b = cut(a, Math.max(a, Math.floor((2 * text.length) / 3)));
  return [text.slice(0, a), text.slice(a, b), text.slice(b)].filter((c) => c.length > 0);
}

export function createGitWrites(ctx: DemoContext, status: () => RepoStatus): GitApi {
  const { root } = ctx.world.project;
  const head = ctx.world.headOid;
  const runs = new Map<string, Array<() => void>>();
  let next = 0;
  const facts = (): GitFacts => ({
    root, identity: true, state: null, detached: false, branch: 'main', head, upstream: 'origin/main', headPushed: true,
    headIsMerge: false, headHasParent: true, headMessage: ctx.world.scm.commits.find((c) => c.oid === head)?.subject ?? null,
    hooks: { preCommit: false, commitMsg: false, prePush: false }, gpgProgram: null, signs: false, gitVersion: [2, 50, 1],
    undo: null, remotes: ['origin']
  });
  /**
   * Changes hears the index changed, as main's watcher tells it after `git add`; the answer's `at` is that status's own
   * time (the demo's clock), so the checkbox's click settles on it (renderer git/stage-intents.ts).
   */
  const changed = (): Promise<GitOpResult> => {
    const s = status();
    ctx.events.emit('git', [s]);
    return resolved<GitOpResult>({ outcome: 'ok', at: s.checkedAt });
  };
  const ok = () => resolved<GitOpResult>({ outcome: 'ok' });
  const notHere = (what: string) => () => { notInDemo(what); return resolved({ ...NOT_HERE }); };

  function stage(r: string, rels: StageTarget): Promise<GitOpResult> {
    if (r !== root) return ok();
    const want = rels === 'all' ? null : new Set(rels);
    // Only listed changes: a path git sees no change in stages nothing.
    for (const c of status().changes) if (!want || want.has(c.rel)) ctx.state.index[c.rel] = ctx.state.files[c.rel] ?? null;
    return changed();
  }
  function unstage(r: string, rels: StageTarget): Promise<GitOpResult> {
    if (r !== root) return ok();
    if (rels === 'all') ctx.state.index = {};
    else for (const rel of rels) delete ctx.state.index[rel];
    return changed();
  }
  const staged = () => status().changes.filter((c) => c.stage !== 'none').map((c) => c.rel);

  return {
    stage, unstage,
    commit: notHere('Committing'), undoCommit: notHere('Committing'),
    push: notHere('Pushing'), pull: notHere('Pulling'), sync: notHere('Syncing'),
    syncAll: () => { notInDemo('Syncing'); return resolved([]); },
    switchTo: notHere('Branches'),
    checkBranchName: () => resolved(true),
    branchCreate: notHere('Branches'), branchRename: notHere('Branches'), branchDelete: notHere('Branches'), branchRestore: notHere('Branches'),
    worktreeCheck: () => resolved({ inside: true, exists: false, ignored: true }),
    worktreeAdd: notHere('Worktrees'),
    stashPush: notHere('Stashes'), stashApply: notHere('Stashes'), stashDrop: notHere('Stashes'), stashRestore: notHere('Stashes'),
    discard: () => { notInDemo('Discarding changes'); return resolved({ ...NOTHING_DISCARDED }); },
    cancel: () => noop(),
    facts: (r) => resolved(r === root ? facts() : null),
    incoming: () => resolved([]),
    remoteCommits: () => resolved({ commits: [], remoteOid: null, total: 0 }),
    running: () => resolved([]),
    message(o) {
      const id = `demo-message-${++next}`;
      const model = ctx.state.settings.commitMessages === 'sonnet' ? 'sonnet' : 'haiku';
      const text = demoMessage(staged(), o.tweak?.kind);
      const parts = chunks(text);
      const timers = parts.map((chunk, i) => ctx.clock.after(MESSAGE_CHUNK_MS * (i + 1), () => {
        ctx.events.emit('scmMessage', { id, chunk });
        if (i < parts.length - 1) return;
        runs.delete(id);
        ctx.events.emit('scmMessage', { id, done: { text, model, ms: MESSAGE_CHUNK_MS * parts.length, notes: [] } });
      }));
      runs.set(id, timers);
      return resolved({ id });
    },
    messageCancel(id) {
      for (const cancel of runs.get(id) ?? []) cancel();
      runs.delete(id);
      return noop();
    }
  };
}
