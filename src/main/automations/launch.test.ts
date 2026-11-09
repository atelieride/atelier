import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { posixOnly, posixTest, useMachinePlatform } from '../../../tests/support/platform';
import { toOut } from '../cpath';
import { writeFileSync } from 'node:fs';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { normalizeAutomation, type Automation } from '@shared/automations';
import { normalizeRun, type Run } from '@shared/automation-run';
import type { TaskDetail } from '@shared/tasks';
import { launchRun, type LaunchPorts } from './launch';

// Real folders: the app's platform switch reads the machine's (canonical C:/ paths on Windows).
useMachinePlatform();

const detail: TaskDetail = {
  id: '86c0x482', displayId: 'CU-482', title: 'Rounding in invoice totals', status: { name: 'Ready for AI' },
  url: 'https://app.clickup.com/t/86c0x482', body: 'Totals are off by a cent.'
};

function world(o: { automation?: Record<string, unknown>; git?: Partial<LaunchPorts['git']>; trust?: 'trusted' | 'untrusted' | 'unknown'; makeFolder?: boolean } = {}) {
  const base = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-launch-'))));
  const project = posix.join(base, 'acme');
  const home = posix.join(base, 'home');
  mkdirSync(join(project, 'packages', 'api'), { recursive: true });
  const automation: Automation = normalizeAutomation({
    id: 'a1', name: 'Bug fixes from ClickUp', project, source: { connector: 'clickup', scopes: ['901500000301'] },
    instructions: 'Write a failing test first.', ...o.automation
  })!;
  const run: Run = normalizeRun({ id: 'r1', automationId: 'a1', createdAt: 1, state: 'starting',
    task: { source: 'clickup', id: detail.id, displayId: detail.displayId, title: detail.title, url: detail.url } })!;
  const taken = new Set(['auto/cu-482-rounding-in-invoice']);
  const worktreeAdd = vi.fn(async (a: { path: string }) => { mkdirSync(a.path, { recursive: true }); mkdirSync(join(a.path, 'packages', 'api'), { recursive: true }); return { outcome: 'ok' as const, message: '' }; });
  const fetchRemote = vi.fn(async (_root: string, _common: string) => true);
  const createSession = vi.fn(async (_o: { project: string; cwd: string; name: string; command: string }) => ({ id: "t-9" }));
  const ports: LaunchPorts = {
    automationsDir: join(home, 'automations'),
    guardDir: join(home, 'automations', 'guard'),
    account: (id) => (id === 'work' ? { dir: '/Users/me/.claude-work', name: 'Work' } : { dir: undefined, name: 'Personal' }),
    trust: vi.fn(async () => o.trust ?? 'trusted'),
    sourceServers: vi.fn(async () => ['clickup-local']),
    git: {
      repoRoot: async (dir) => (dir.startsWith(project) ? { root: project, common: join(project, '.git') } : null),
      version: async () => 'git version 2.54.0 (Apple Git-157)',
      defaultStart: async () => 'refs/remotes/origin/main',
      hasRemote: async () => true,
      currentBranch: async () => 'feature/x',
      branchExists: async (_root, name) => taken.has(name) || name === 'release/1.2',
      remoteUrls: async () => ['deploy@build.example:acme.git', 'https://github.com/acme/acme'],
      fetchRemote,
      worktreeAdd,
      oid: async (_root, ref) => (ref.startsWith('refs/heads/auto/') ? 'b'.repeat(40) : null),
      ...o.git
    },
    createSession
  };
  return { project, home, automation, run, ports, worktreeAdd, fetchRemote, createSession };
}

const files = (runDir: string) => ({
  script: readFileSync(join(runDir, 'launch.sh'), 'utf8'),
  system: readFileSync(join(runDir, 'system.md'), 'utf8'),
  prompt: readFileSync(join(runDir, 'prompt.md'), 'utf8')
});

// The macOS launcher (launch.sh, POSIX paths); Windows has its own below.
posixOnly('launchRun: checks, worktree, launcher, session', () => {
  test('the default base after a fetch, the first free branch name, the guard, the files, the session in the worktree', async () => {
    const w = world();
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    const wt = join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-invoice-2');
    expect(r).toEqual({ ok: true, terminalId: 't-9', branch: 'auto/cu-482-rounding-in-invoice-2', worktree: wt, base: 'refs/remotes/origin/main', baseOid: 'b'.repeat(40) });
    expect(w.fetchRemote).toHaveBeenCalledWith(w.project, join(w.project, '.git'));
    expect(w.worktreeAdd).toHaveBeenCalledWith({ project: w.project, root: w.project, path: wt, start: 'refs/remotes/origin/main', newName: 'auto/cu-482-rounding-in-invoice-2' });
    const runDir = join(w.home, 'automations', 'runs', 'r1');
    const f = files(runDir);
    expect(f.script).toContain(`export GIT_CONFIG_VALUE_0='${join(w.home, 'automations', 'guard')}'`);
    expect(f.script).toContain("export ATELIER_RUN_BRANCH='auto/cu-482-rounding-in-invoice-2'");
    expect(f.script).toContain("'deploy@build.example:'");
    expect(f.script).toContain("'mcp__claude_ai_ClickUp' 'mcp__clickup-local'");
    expect(f.script).not.toContain('AskUserQuestion');
    expect(f.system).toContain('You were started by the Atelier automation "Bug fixes from ClickUp" for ClickUp task CU-482.');
    expect(f.system).toContain('Write a failing test first.');
    expect(f.system).toContain('Don\'t use ClickUp tools in this session.');
    expect(f.prompt.startsWith('ClickUp task CU-482: Rounding in invoice totals\n')).toBe(true);
    expect(w.createSession).toHaveBeenCalledWith({ project: w.project, cwd: wt, name: 'CU-482 Rounding in invoice totals', command: `. '${join(runDir, 'launch.sh')}'` });
  });

  test('a subfolder: the session starts in the same folder of the worktree', async () => {
    const w = world({ automation: { folder: 'packages/api' } });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    expect(r.ok).toBe(true);
    expect(w.createSession.mock.calls[0]![0]).toMatchObject({ cwd: join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-invoice-2', 'packages', 'api') });
  });

  test('a project inside a larger repository: the worktree in the project (so is the session), the guard over the whole repository', async () => {
    const w = world();
    const root = join(w.project, '..');
    w.ports.git.repoRoot = async () => ({ root, common: join(root, '.git') });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    const wt = join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-invoice-2');
    expect(r).toMatchObject({ ok: true, worktree: wt });
    expect(w.worktreeAdd).toHaveBeenCalledWith(expect.objectContaining({ project: w.project, root, path: wt }));
    // The session's folder is the project's own folder inside the worktree's checkout.
    expect(w.createSession.mock.calls[0]![0]).toMatchObject({ project: w.project, cwd: join(wt, 'acme') });
    const f = files(join(w.home, 'automations', 'runs', 'r1'));
    expect(f.script).toContain(`export ATELIER_RUN_PROJECT='${root}'`);
    expect(f.script).toContain(`export ATELIER_RUN_WORKTREE='${wt}'`);
  });

  test('a repository inside the project (its folder): the worktree in the repository, the guard over the project', async () => {
    const w = world({ automation: { folder: 'packages/api' } });
    const root = join(w.project, 'packages', 'api');
    w.ports.git.repoRoot = async () => ({ root, common: join(root, '.git') });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    const wt = join(root, '.claude', 'worktrees', 'auto-cu-482-rounding-in-invoice-2');
    expect(r).toMatchObject({ ok: true, worktree: wt });
    expect(w.createSession.mock.calls[0]![0]).toMatchObject({ cwd: wt });
    expect(files(join(w.home, 'automations', 'runs', 'r1')).script).toContain(`export ATELIER_RUN_PROJECT='${w.project}'`);
  });

  test('Retry of a run whose worktree was made: the same branch and worktree, nothing created again', async () => {
    const w = world();
    const wt = join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-invoice');
    mkdirSync(wt, { recursive: true });
    const retried = { ...w.run, branch: 'auto/cu-482-rounding-in-invoice', worktree: wt, base: 'refs/remotes/origin/main', baseOid: 'c'.repeat(40) };
    const r = await launchRun(w.automation, retried, detail, w.ports);
    expect(r).toEqual({ ok: true, terminalId: 't-9', branch: 'auto/cu-482-rounding-in-invoice', worktree: wt, base: 'refs/remotes/origin/main', baseOid: 'c'.repeat(40) });
    expect(w.worktreeAdd).not.toHaveBeenCalled();
    expect(w.fetchRemote).not.toHaveBeenCalled();
    expect(w.createSession.mock.calls[0]![0]).toMatchObject({ cwd: wt });
    // Its folder gone (removed by Close Run): a new one, as for a first start.
    const again = world();
    const gone = await launchRun(again.automation, { ...again.run, branch: 'auto/cu-482-rounding-in-invoice', worktree: join(again.project, 'nope') }, detail, again.ports);
    expect(gone).toMatchObject({ ok: true, branch: 'auto/cu-482-rounding-in-invoice-2' });
    expect(again.worktreeAdd).toHaveBeenCalled();
  });

  test('bases: the current branch, a named one, or the local default without a remote (no fetch then)', async () => {
    const current = world({ automation: { isolation: { base: 'current' } } });
    await launchRun(current.automation, current.run, detail, current.ports);
    expect(current.worktreeAdd.mock.calls[0]![0]).toMatchObject({ start: 'refs/heads/feature/x' });
    expect(current.fetchRemote).not.toHaveBeenCalled();
    const named = world({ automation: { isolation: { base: { branch: 'release/1.2' } } } });
    await launchRun(named.automation, named.run, detail, named.ports);
    expect(named.worktreeAdd.mock.calls[0]![0]).toMatchObject({ start: 'refs/heads/release/1.2' });
    const local = world({ git: { hasRemote: async () => false, defaultStart: async () => 'refs/heads/main' } });
    await launchRun(local.automation, local.run, detail, local.ports);
    expect(local.fetchRemote).not.toHaveBeenCalled();
    expect(local.worktreeAdd.mock.calls[0]![0]).toMatchObject({ start: 'refs/heads/main' });
  });

  test('a fetch that fails still starts, from what was fetched last, and says so', async () => {
    const w = world({ git: { fetchRemote: async () => false } });
    expect(await launchRun(w.automation, w.run, detail, w.ports)).toMatchObject({ ok: true, note: 'Couldn\'t fetch: started from the last fetched origin/main' });
  });

  test('decide on its own: AskUserQuestion denied, the rule in the system prompt; the source in the session: allowed', async () => {
    const w = world({ automation: { claude: { decideAlone: true, useSourceMcp: true, account: 'work', model: 'sonnet', mode: 'plan' } } });
    await launchRun(w.automation, w.run, detail, w.ports);
    const f = files(join(w.home, 'automations', 'runs', 'r1'));
    expect(f.script).toContain("'AskUserQuestion'");
    expect(f.script).not.toContain('mcp__claude_ai_ClickUp');
    expect(f.script).toContain("CLAUDE_CONFIG_DIR='/Users/me/.claude-work' claude --name='CU-482 Rounding in invoice totals' --model sonnet --permission-mode plan");
    expect(f.system).toContain('"Decisions I made"');
    expect(f.prompt).toContain('If a ClickUp MCP server is available');
    // A repository: its main checkout's root decides (Claude Code's own rule), never a folder above it.
    expect(w.ports.trust).toHaveBeenCalledWith('/Users/me/.claude-work', w.project, { gitRoot: true });
  });

  test('without a worktree: the folder itself, guarded on its current branch', async () => {
    const w = world({ automation: { isolation: { worktree: false } } });
    expect(await launchRun(w.automation, w.run, detail, w.ports)).toEqual({ ok: true, terminalId: 't-9' });
    expect(w.worktreeAdd).not.toHaveBeenCalled();
    expect(files(join(w.home, 'automations', 'runs', 'r1')).script).toContain("export ATELIER_RUN_BRANCH='feature/x'");
    expect(w.createSession.mock.calls[0]![0]).toMatchObject({ cwd: w.project });
  });

  test('every reason not to start, before anything is created', async () => {
    const cases: [ReturnType<typeof world>, string][] = [
      [world({ automation: { folder: 'gone' } }), 'The folder gone isn\'t in acme anymore.'],
      [world({ git: { repoRoot: async () => null } }), 'acme isn\'t a git repository, so runs can\'t have their own worktree.'],
      [world({ git: { version: async () => 'git version 2.27.1' } }), 'Automations need git 2.28 or newer (this Mac has 2.27.1).'],
      [world({ trust: 'untrusted' }), 'Claude Code doesn\'t trust this folder yet for Personal: start one session in acme and accept.'],
      [world({ automation: { isolation: { base: { branch: 'gone/branch' } } } }), 'The branch gone/branch isn\'t there anymore.'],
      [world({ git: { branchExists: async () => true } }), 'Every branch name for this task is taken: auto/cu-482-rounding-in-invoice…'],
      [world({ git: { currentBranch: async () => null }, automation: { isolation: { worktree: false } } }), 'acme is on a detached HEAD: pick a branch, or turn the worktree on.']
    ];
    for (const [w, reason] of cases) {
      expect(await launchRun(w.automation, w.run, detail, w.ports), reason).toEqual({ ok: false, reason });
      expect(w.worktreeAdd).not.toHaveBeenCalled();
      expect(w.createSession).not.toHaveBeenCalled();
    }
  });

  test('git refusing the worktree, or atelierd the session: the reason, and no session', async () => {
    const w = world({ git: { worktreeAdd: async () => ({ outcome: 'error' as const, message: 'fatal: a branch named x already exists' }) } });
    expect(await launchRun(w.automation, w.run, detail, w.ports)).toEqual({ ok: false, reason: 'Couldn\'t create the worktree: fatal: a branch named x already exists' });
    expect(w.createSession).not.toHaveBeenCalled();
    const s = world();
    s.createSession.mockRejectedValueOnce(new Error('atelierd is not running'));
    expect(await launchRun(s.automation, s.run, detail, s.ports)).toMatchObject({ ok: false, reason: 'Couldn\'t start the session: atelierd is not running' });
  });
});

describe('launchRun on Windows', () => {
  afterEach(() => { resetPlatformForTests(); });
  const guarded = (w: ReturnType<typeof world>) => {
    mkdirSync(posix.join(w.home, 'automations', 'guard', 'bin'), { recursive: true });
    writeFileSync(posix.join(w.home, 'automations', 'guard', 'bin', 'git.exe'), 'MZ');
  };

  test('without the guard\'s git.exe nothing starts, and it says why', async () => {
    const w = world();
    initPlatform('win32');
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    expect(r).toEqual({ ok: false, reason: 'Atelier\'s git guard isn\'t installed (atelier-git.exe is missing): reinstall Atelier.' });
    expect(w.worktreeAdd).not.toHaveBeenCalled();
    expect(w.createSession).not.toHaveBeenCalled();
  });

  test('a short worktree folder, the next candidate when that folder is taken; launch.ps1 typed into the terminal', async () => {
    const w = world();
    initPlatform('win32');
    guarded(w);
    // The first free branch is -2 (the world's ports); its 20-character folder is already there: -3.
    mkdirSync(posix.join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-2'), { recursive: true });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    expect(r).toMatchObject({ ok: true, branch: 'auto/cu-482-rounding-in-invoice-3', worktree: posix.join(w.project, '.claude', 'worktrees', 'auto-cu-482-rounding-in-3') });
    expect(w.createSession.mock.calls[0]![0].command).toMatch(/^\. '.*launch\.ps1'$/);
  });

  test('a project inside a larger repository: the scope reads its drive and folders whatever their case', async () => {
    const w = world();
    initPlatform('win32');
    guarded(w);
    const root = posix.join(w.project, '..').toUpperCase();
    w.ports.git.repoRoot = async () => ({ root, common: posix.join(root, '.git') });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    expect(r).toMatchObject({ ok: true });
    expect(w.worktreeAdd).toHaveBeenCalledWith(expect.objectContaining({ project: w.project, root }));
    expect(String(w.worktreeAdd.mock.calls[0]![0].path).startsWith(posix.join(w.project, '.claude', 'worktrees'))).toBe(true);
  });
});

posixOnly('trust: what Claude Code itself asks about', () => {
  test('a project inside a larger repository: the repository\'s root is the one Claude Code asks about, and named', async () => {
    const w = world({ trust: 'untrusted' });
    const root = join(w.project, '..');
    w.ports.git.repoRoot = async () => ({ root, common: join(root, '.git') });
    const r = await launchRun(w.automation, w.run, detail, w.ports);
    expect(w.ports.trust).toHaveBeenCalledWith(undefined, root, { gitRoot: true });
    expect(r).toEqual({ ok: false, reason: `Claude Code doesn't trust this folder yet for Personal: start one session in ${root.split('/').pop()} and accept.` });
  });

  test('the project is a linked worktree of another checkout: that checkout\'s root decides', async () => {
    const w = world();
    const main = join(w.project, '..', 'main-checkout');
    w.ports.git.repoRoot = async () => ({ root: w.project, common: join(main, '.git') });
    await launchRun(w.automation, w.run, detail, w.ports);
    expect(w.ports.trust).toHaveBeenCalledWith(undefined, main, { gitRoot: true });
  });

  test('no repository (no worktree): the folder, and the folders above it, as Claude Code does', async () => {
    const w = world({ automation: { isolation: { worktree: false } } });
    w.ports.git.repoRoot = async () => null;
    await launchRun(w.automation, w.run, detail, w.ports);
    expect(w.ports.trust).toHaveBeenCalledWith(undefined, w.project, { gitRoot: false });
  });
});

describe('launchRun on Windows: what it says', () => {
  afterEach(() => { resetPlatformForTests(); });

  test('git too old: "this PC"; no git at all: Git for Windows, not "isn\'t a git repository"', async () => {
    const old = world({ git: { version: async () => 'git version 2.27.1.windows.1' } });
    const none = world({ git: { version: async () => null, repoRoot: async () => null } });
    initPlatform('win32');
    for (const w of [old, none]) {
      mkdirSync(posix.join(w.home, 'automations', 'guard', 'bin'), { recursive: true });
      writeFileSync(posix.join(w.home, 'automations', 'guard', 'bin', 'git.exe'), 'MZ');
    }
    expect(await launchRun(old.automation, old.run, detail, old.ports)).toEqual({ ok: false, reason: 'Automations need git 2.28 or newer (this PC has 2.27.1).' });
    expect(await launchRun(none.automation, none.run, detail, none.ports)).toEqual({ ok: false, reason: 'Automations need Git for Windows (git-scm.com): install it, then try again.' });
  });

  posixTest('macOS: no git at all says so too', async () => {
    const none = world({ git: { version: async () => null, repoRoot: async () => null } });
    expect(await launchRun(none.automation, none.run, detail, none.ports)).toEqual({ ok: false, reason: 'Automations need git, and this Mac has none: install the Xcode Command Line Tools, then try again.' });
  });
});
