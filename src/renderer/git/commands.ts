// The Git menu's commands and the palette's: what they act on and what they open. The menu
// (src/shared/menu-spec.ts) sends them to App's command switch; the palette offers the same ones with the same
// visibility, plus "Commit <session>'s Work…" for the focused session. Read-only: none of them runs.
import type { MenuCommand } from '@shared/api';
import type { IconName } from '../components/Icon';
import { buildRows, groupBySession } from '../changes';
import { t } from '../i18n/en';
import { withScm } from '../scm/data';
import { useApp, type AppState } from '../store';
import { hideWorktreeFolders } from '../worktrees';
import { commitWork, openCommitAll, openCommitDrawer, push, syncAll, undoLastCommit } from './actions';
import { openNewBranch, openStash, openSwitchPicker } from './branches';
import { writeMessageCommand } from './message-run';
import { stageable, type StageRow } from './staging';
import { startPull, startSync } from './sync';
import { stagedCount } from './target';
import { kbd } from '../kbd';

export type GitCommand = Extract<MenuCommand, `git-${string}`>;

const st = () => useApp.getState();

/**
 * The repository a Git command acts on (as Fetch does): Source Control's selected one, else the commit target, else
 * the first with changes, else the first.
 */
export function commandRepo(s: Pick<AppState, 'scmRepo' | 'gitTarget' | 'repos'>): string | null {
  return s.scmRepo ?? s.gitTarget ?? s.repos.find((r) => r.changes.length > 0)?.root ?? s.repos[0]?.root ?? null;
}

/** Runs a Git menu (or palette) command; the actions themselves refuse in Read-only. */
export async function runGitCommand(cmd: GitCommand): Promise<void> {
  if (st().settings.gitActions !== 'on') return;
  switch (cmd) {
    case 'git-commit': openCommitDrawer(); return;
    case 'git-write-message': await writeMessageCommand(); return;
    case 'git-undo-commit': await undoLastCommit(); return;
    case 'git-sync-all': await syncAll(); return;
    case 'git-commit-all':
      if (!st().repos.some((r) => stagedCount(r) > 0)) st().showToast(t.git.cmd.nothingStaged, undefined, 'info');
      else openCommitAll();
      return;
    case 'git-switch-branch': await withScm(openSwitchPicker); return;
  }
  // The rest act on one repository: Source Control's list first, as Fetch does.
  await withScm(() => {});
  const root = commandRepo(st());
  if (!root) return;
  switch (cmd) {
    case 'git-push': await push(root); return;
    case 'git-pull': await startPull(root); return;
    case 'git-sync': await startSync(root); return;
    case 'git-new-branch': openNewBranch(root); return;
    case 'git-stash': openStash(root); return;
  }
}

let lastWork: { repos: AppState['repos']; attributions: AppState['attributions']; terminalId: string; rows: StageRow[] } | null = null;

/**
 * The files a session surely changed that can be staged, in every repository. The palette asks on every store
 * change: the answer is kept until the repositories, the attributions or the session change.
 */
export function sessionWork(s: Pick<AppState, 'repos' | 'attributions'>, terminalId: string): StageRow[] {
  if (lastWork && lastWork.repos === s.repos && lastWork.attributions === s.attributions && lastWork.terminalId === terminalId) return lastWork.rows;
  const g = groupBySession(buildRows(hideWorktreeFolders(s.repos), s.attributions)).find((x) => x.key === terminalId);
  const rows = (g?.rows ?? []).filter((r) => stageable(r).ok);
  lastWork = { repos: s.repos, attributions: s.attributions, terminalId, rows };
  return rows;
}

/** "Commit <session>'s Work…" from the palette: that session's files as Changes lists them now. */
export function commitSessionWork(terminalId: string): Promise<void> {
  return commitWork(terminalId, sessionWork(st(), terminalId));
}

export interface GitPaletteInput {
  hasRepos: boolean;
  /** Git actions on (not Read-only). */
  writes: boolean;
  /** Messages with Claude on. */
  messages: boolean;
  /** Main offers an Undo for a commit of this project. */
  undo: boolean;
  /** The repository the commands act on (commandRepo), with its name. */
  repo: { root: string; name: string } | null;
  /** That repository has a remote; some repository of the project has one. */
  remote: boolean;
  anyRemote: boolean;
  /** The focused session, when it surely changed files. */
  work: { id: string; title: string; files: number } | null;
}

export interface GitPaletteCommand { key: string; label: string; hint: string; icon: IconName; command: GitCommand | 'commit-work'; session?: string }

/**
 * The palette's git commands: the Git menu's write commands with its visibility (none without a repository or in
 * Read-only, ✦ only with messages on), Undo only while offered, Push/Pull/Sync only toward a remote (as Fetch), and
 * "Commit <session>'s Work…" for the focused session. The Fetch commands stay the palette's own.
 */
export function gitPaletteCommands(o: GitPaletteInput): GitPaletteCommand[] {
  if (!o.hasRepos || !o.writes) return [];
  const c = t.git.cmd;
  const name = o.repo?.name ?? '';
  const cmd = (key: GitCommand, label: string, hint: string, icon: IconName): GitPaletteCommand => ({ key, label, hint, icon, command: key });
  return [
    ...(o.work ? [{ key: 'git-commit-work', label: t.git.menu.commitWork(o.work.title), hint: c.files(o.work.files), icon: 'commit' as const, command: 'commit-work' as const, session: o.work.id }] : []),
    cmd('git-commit', c.commit, kbd('⌘⌥K'), 'commit'),
    cmd('git-commit-all', c.commitAll, '', 'commit'),
    ...(o.messages ? [cmd('git-write-message', c.writeMessage, kbd('⌘⌥M'), 'sparkle')] : []),
    ...(o.undo ? [cmd('git-undo-commit', c.undo, '', 'resume')] : []),
    ...(o.repo && o.remote ? [cmd('git-push', c.push, name, 'arrowUp'), cmd('git-pull', c.pull, name, 'arrowDown'), cmd('git-sync', c.sync, name, 'sync')] : []),
    ...(o.anyRemote ? [cmd('git-sync-all', c.syncAll, '', 'sync')] : []),
    ...(o.repo ? [cmd('git-new-branch', c.newBranch, name, 'branchOff'), cmd('git-switch-branch', c.switchBranch, name, 'swap'), cmd('git-stash', c.stash, name, 'stash')] : [])
  ];
}

/** Runs a palette git command. */
export function runPaletteGit(c: GitPaletteCommand): void {
  if (c.command === 'commit-work') { if (c.session) void commitSessionWork(c.session); return; }
  void runGitCommand(c.command);
}
