// Starting a run: the checks, the base and the branch, the worktree through GitOps, the launcher
// files and the session. Every dependency is a port, so the order and every refusal are tested without git or atelierd.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from '../cpath';
import type { Automation } from '@shared/automations';
import { branchCandidates, systemPrompt, worktreeDir, type Run } from '@shared/automation-run';
import type { GitOpResult } from '@shared/git-write';
import { buildTaskPrompt, taskSessionName } from '@shared/task-prompt';
import type { TaskDetail } from '@shared/tasks';
import { isInside } from '@shared/paths';
import { currentPlatform } from '@shared/platform';
import { guardBin, guardEnv, guardGit, pushPrefixes } from './guard';
import { disallowedTools, launchCommand, writeLaunchFiles } from './launcher';

export interface LaunchPorts {
  /** ATELIER_HOME/automations. */
  automationsDir: string;
  guardDir: string;
  /** An account's config dir (undefined: the default account) and name. */
  account(id: string): { dir: string | undefined; name: string };
  /** Claude Code's trust for `dir`; `gitRoot`: dir is a repository's main checkout, where only it counts. */
  trust(accountDir: string | undefined, dir: string, o: { gitRoot: boolean }): Promise<'trusted' | 'untrusted' | 'unknown'>;
  /** The task source's servers in Claude Code for this account and project: their tool name prefixes. */
  sourceServers(accountDir: string | undefined, project: string, connector: Automation['source']['connector']): Promise<string[]>;
  git: {
    repoRoot(dir: string): Promise<{ root: string; common: string } | null>;
    /** `git version`'s line, null when git can't be run. */
    version(): Promise<string | null>;
    /** The default branch's full ref: refs/remotes/origin/<b> with a remote, else refs/heads/main|master; null: none. */
    defaultStart(root: string): Promise<string | null>;
    hasRemote(root: string): Promise<boolean>;
    currentBranch(dir: string): Promise<string | null>;
    branchExists(root: string, name: string): Promise<boolean>;
    remoteUrls(root: string): Promise<string[]>;
    /** Fetch through git/fetch.ts; false when it failed. */
    fetchRemote(root: string, common: string): Promise<boolean>;
    worktreeAdd(a: { project: string; root: string; path: string; start: string; newName: string }): Promise<GitOpResult>;
    /** A full ref's commit, null when there is none. */
    oid(root: string, ref: string): Promise<string | null>;
  };
  createSession(o: { project: string; cwd: string; name: string; command: string }): Promise<{ id: string }>;
}

export type LaunchResult =
  | { ok: true; terminalId: string; branch?: string; worktree?: string; note?: string; base?: string; baseOid?: string }
  | { ok: false; reason: string; branch?: string; worktree?: string };

const SOURCE_NAMES = { clickup: 'ClickUp', notion: 'Notion', jira: 'Jira' } as const;
/** The claude.ai connector of each source, as Claude Code names its server (denied unless the user allows it). */
const CLAUDE_AI_SERVERS = { clickup: 'claude_ai_ClickUp', notion: 'claude_ai_Notion', jira: 'claude_ai_Atlassian' } as const;
const MIN_GIT: [number, number] = [2, 28];

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** `inner` is `outer` or inside it (any case on Windows). */
const within = (outer: string, inner: string) => isInside(outer, inner);

function gitTooOld(line: string | null): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(line ?? '');
  if (!m) return 'unknown';
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_GIT[0] || (maj === MIN_GIT[0] && min >= MIN_GIT[1]) ? null : m[0];
}

/** The main checkout of a repository: the common dir's folder (`<main>/.git`), else the top level as git gives it. */
function mainCheckout(repo: { root: string; common: string }): string {
  const common = repo.common.replace(/[\\/]+$/, '');
  return basename(common) === '.git' ? dirname(common) : repo.root;
}

/** Starts `run` of `a` on the task `detail`. Nothing is created before every check has passed. */
export async function launchRun(a: Automation, run: Run, detail: TaskDetail, p: LaunchPorts): Promise<LaunchResult> {
  const project = a.project;
  const projectName = basename(project);
  const folder = a.folder ? join(project, a.folder) : project;
  if (!isDir(folder)) return { ok: false, reason: `The folder ${a.folder} isn't in ${projectName} anymore.` };
  const account = p.account(a.claude.account);

  // Windows: the session's git is the app's atelier-git.exe, copied at start; without it, no guard.
  if (currentPlatform() === 'win32' && !existsSync(guardGit(p.guardDir))) {
    return { ok: false, reason: 'Atelier\'s git guard isn\'t installed (atelier-git.exe is missing): reinstall Atelier.' };
  }
  const windows = currentPlatform() === 'win32';
  const version = await p.git.version();
  // No git at all (optional on Windows): said as such, not as "isn't a git repository".
  if (a.isolation.worktree && version === null) {
    return { ok: false, reason: windows ? 'Automations need Git for Windows (git-scm.com): install it, then try again.'
      : 'Automations need git, and this Mac has none: install the Xcode Command Line Tools, then try again.' };
  }
  const repo = await p.git.repoRoot(folder);
  if (a.isolation.worktree && !repo) return { ok: false, reason: `${projectName} isn't a git repository, so runs can't have their own worktree.` };
  if (repo) {
    const old = gitTooOld(version);
    if (old) return { ok: false, reason: `Automations need git 2.28 or newer (this ${windows ? 'PC' : 'Mac'} has ${old}).` };
  }
  // What Claude Code itself asks about: a repository's main checkout (a run's worktree follows it), else the folder.
  const trustDir = repo ? mainCheckout(repo) : project;
  if ((await p.trust(account.dir, trustDir, { gitRoot: !!repo })) === 'untrusted') {
    return { ok: false, reason: `Claude Code doesn't trust this folder yet for ${account.name}: start one session in ${basename(trustDir)} and accept.` };
  }

  let branch: string;
  let worktree: string | undefined;
  let note: string | undefined;
  let started: { base: string; baseOid: string } | undefined;
  let cwd = folder;
  // Retry of a run whose worktree was made (its session couldn't start): the same branch and worktree, nothing new.
  const again = a.isolation.worktree && repo && run.branch && run.worktree && within(project, run.worktree) && isDir(run.worktree)
    && (await p.git.branchExists(repo.root, run.branch)) ? { branch: run.branch, worktree: run.worktree } : null;
  if (again && repo) {
    branch = again.branch;
    worktree = again.worktree;
    if (run.base && run.baseOid) started = { base: run.base, baseOid: run.baseOid };
    cwd = join(worktree, relative(repo.root, folder));
  } else if (a.isolation.worktree && repo) {
    let start: string | null;
    const base = a.isolation.base;
    if (base === 'current') {
      const b = await p.git.currentBranch(folder);
      start = b ? `refs/heads/${b}` : null;
      if (!start) return { ok: false, reason: `${projectName} is on a detached HEAD: pick a base branch for its runs.` };
    } else if (typeof base === 'object') {
      if (!(await p.git.branchExists(repo.root, base.branch))) return { ok: false, reason: `The branch ${base.branch} isn't there anymore.` };
      start = `refs/heads/${base.branch}`;
    } else {
      if (await p.git.hasRemote(repo.root)) {
        if (!(await p.git.fetchRemote(repo.root, repo.common))) note = 'fetch-failed';
      }
      start = await p.git.defaultStart(repo.root);
      if (!start) return { ok: false, reason: `${projectName} has no default branch to start from: pick a base branch for its runs.` };
      if (note) note = `Couldn't fetch: started from the last fetched ${start.replace(/^refs\/(?:remotes|heads)\//, '')}`;
    }
    const candidates = branchCandidates(detail.displayId, detail.title);
    // In the project (a project inside a larger repository keeps its worktrees, and the session, in itself).
    const home = within(repo.root, project) ? project : repo.root;
    let free: string | null = null;
    // A free branch whose folder is free too (Windows' short folders can meet another task's).
    for (const c of candidates) if (!isDir(worktreeDir(home, c)) && !(await p.git.branchExists(repo.root, c))) { free = c; break; }
    if (!free) return { ok: false, reason: `Every branch name for this task is taken: ${candidates[0] ?? 'auto/…'}…` };
    branch = free;
    worktree = worktreeDir(home, branch);
    const made = await p.git.worktreeAdd({ project, root: repo.root, path: worktree, start, newName: branch });
    if (made.outcome !== 'ok') return { ok: false, reason: `Couldn't create the worktree: ${made.message}` };
    const baseOid = await p.git.oid(repo.root, `refs/heads/${branch}`).catch(() => null);
    if (baseOid) started = { base: start, baseOid };
    cwd = join(worktree, relative(repo.root, folder));
  } else {
    const current = repo ? await p.git.currentBranch(folder) : 'automation-run';
    if (!current) return { ok: false, reason: `${projectName} is on a detached HEAD: pick a branch, or turn the worktree on.` };
    branch = current;
  }

  const source = SOURCE_NAMES[a.source.connector];
  const denySource = !a.claude.useSourceMcp;
  const runDir = join(p.automationsDir, 'runs', run.id);
  const { script } = writeLaunchFiles({
    runDir,
    name: taskSessionName(detail.displayId, detail.title),
    model: a.claude.model,
    mode: a.claude.mode,
    ...(account.dir ? { configDir: account.dir } : {}),
    // The PATH git keeps every command inside the run's worktree over the whole repository, or the project when wider.
    guard: guardEnv({ guardDir: p.guardDir, branch, pushPrefixes: pushPrefixes(repo ? await p.git.remoteUrls(repo.root) : []), worktree: worktree ?? folder,
      project: repo && within(repo.root, project) ? repo.root : project }),
    pathPrefix: guardBin(p.guardDir),
    // Denied unless allowed: the claude.ai connector's name always (it may be connected later), and every server found.
    disallowed: disallowedTools({
      decideAlone: a.claude.decideAlone,
      denyServers: denySource ? [...new Set([CLAUDE_AI_SERVERS[a.source.connector], ...(await p.sourceServers(account.dir, project, a.source.connector).catch(() => []))])] : []
    }),
    system: systemPrompt({
      automation: a.name, source, displayId: detail.displayId, branch, instructions: a.instructions,
      decideAlone: a.claude.decideAlone, sourceMcp: denySource ? 'denied' : 'allowed'
    }),
    prompt: buildTaskPrompt(source, detail, { readLine: !denySource })
  });
  const made = worktree ? { branch, worktree, ...started } : {};
  try {
    const s = await p.createSession({ project, cwd, name: taskSessionName(detail.displayId, detail.title), command: launchCommand(script) });
    return { ok: true, terminalId: s.id, ...made, ...(note ? { note } : {}) };
  } catch (e) {
    return { ok: false, reason: `Couldn't start the session: ${(e as Error).message}`, ...made };
  }
}
