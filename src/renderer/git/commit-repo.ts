// A commit from a block of Source Control's All Repositories view: the drawer's rules outside the drawer — what is
// staged, the repository's draft, Co-authored-by (the
// setting, when a staged file is surely a session's) and "When nothing is staged". No Amend here:
// that is the drawer's ("Open in Commit Drawer").
import type { GitOpResult } from '@shared/git-write';
import { buildRows } from '../changes';
import { t } from '../i18n/en';
import { useApp, type AppState } from '../store';
import { changesInWorkspace } from '../workspace-view';
import { commit, stage } from './actions';
import { coAuthorShown, commitBlock, drawerNotices } from './drawer';
import { stageAllPlan, type StageAllPlan } from './stage-all';
import { stagedCount } from './target';

export interface RepoCommitState {
  staged: number;
  /** Nothing staged and Commit would stage everything first (the setting isn't Don't commit). */
  offered: boolean;
  /** Why Commit can't run now (the drawer's words), null when it can. */
  block: string | null;
  /** What Stage All would take, when it is offered. */
  plan: StageAllPlan | null;
  name: string;
}

/** What Commit can do in that working tree now. */
export function repoCommitState(root: string, s: AppState = useApp.getState()): RepoCommitState {
  const repo = s.repos.find((r) => r.root === root);
  if (!repo) return { staged: 0, offered: false, block: t.git.drawer.noTarget, plan: null, name: '' };
  const staged = stagedCount(repo);
  const mode = s.settings.commitNothingStaged;
  // Changes showing This workspace: Stage All takes only the rows shown, as the drawer's.
  const ws = s.ws?.on && !s.popout && s.changesScope === 'ws' ? s.ws : null;
  const all = stageAllPlan({ repo, shown: ws ? changesInWorkspace(ws, buildRows([repo], s.attributions)) : null, writes: s.settings.gitActions === 'on' });
  const running = committing.has(root) || Object.values(s.gitOps).some((e) => e.root === root && e.op !== 'stage' && e.op !== 'unstage');
  const notices = drawerNotices({ target: root, repos: s.repos, facts: s.gitFacts[root], allFacts: {}, live: new Map(), results: {}, actedAt: 0, now: 0 });
  // ✦ writing this message: the field is Claude's until it is done (the drawer's rule).
  const writing = s.gitWrite?.root === root && s.gitWrite.phase === 'writing';
  const block = writing ? t.git.write.busy : commitBlock({
    target: root, name: repo.name, staged, message: s.gitDrafts[root] ?? '', running, notices,
    nothingStaged: { mode, offered: all.offered, conflicts: !all.offered && all.why === 'conflicts' }
  });
  return { staged, offered: all.offered && mode !== 'never', block, plan: all.offered ? all.plan : null, name: repo.name };
}

/** The working trees a block is committing (its stage too): a second click while one runs does nothing. */
const committing = new Set<string>();

async function once<R>(root: string, fn: () => Promise<R>): Promise<R | null> {
  if (committing.has(root)) return null;
  committing.add(root);
  try { return await fn(); } finally { committing.delete(root); }
}

/** The commit itself, with the draft as it is now; Co-authored-by judged on the rows staged now. */
function commitNow(root: string, o: { push?: boolean }): Promise<GitOpResult | null> {
  const s = useApp.getState();
  const repo = s.repos.find((r) => r.root === root);
  const coAuthor = s.settings.commitCoAuthor && !!repo && coAuthorShown(buildRows([repo], s.attributions));
  return commit({ root, message: s.gitDrafts[root] ?? '', amend: false, coAuthor, noVerify: false, push: !!o.push, keepDrawer: true });
}

/**
 * The block's Commit (and Commit and Push): 'ask' when nothing is staged and the setting asks (the block shows the
 * question); with Stage all, everything is staged first. Null when nothing ran (blocked, or already committing).
 */
export async function commitRepo(root: string, o: { push?: boolean }): Promise<'ask' | GitOpResult | null> {
  const c = repoCommitState(root);
  if (c.block) return null;
  if (c.staged > 0) return once(root, () => commitNow(root, o));
  if (!c.offered) return null;
  if (useApp.getState().settings.commitNothingStaged === 'ask') return 'ask';
  return stageThenCommitRepo(root, o);
}

/** Nothing staged, answered (or not asked): everything Stage All takes, then the commit; a failed stage stops there. */
export function stageThenCommitRepo(root: string, o: { push?: boolean }): Promise<GitOpResult | null> {
  return once(root, async () => {
    const c = repoCommitState(root);
    if (!c.plan || c.staged > 0) return null;
    const r = await stage(root, c.plan.what);
    if (r?.outcome !== 'ok') return r;
    return commitNow(root, o);
  });
}
