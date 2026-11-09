import { describe, expect, test } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { PR_FIELDS } from '@shared/pr';
import { classifyGhFailure, findGh, ghArgs, ghEnv, validBranch, validateGhArgs, viewPr, type GhExec } from './exec';

describe('validBranch (git ref rules, and nothing gh would read as a PR number or a flag)', () => {
  test.each(['feature/x', 'main', 'fix-123', 'user/feat_2.0', 'release/v2.1', 'a.b', 'x'.repeat(200)])('allowed: %s', (b) => expect(validBranch(b)).toBe(true));
  test.each([
    '', ' ', 'a b', 'a;b', 'a\tb', 'a\nb', '-x', '--web', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a.lock', 'a/', '/a', 'a//b',
    'a.', '.a', 'a/.b', 'a@{1}', '@', 'x'.repeat(201), '123', '#12', 'a\u0000b', 'a\u007fb', 'a$(rm)', 'a`b`', "a'b", 'a"b', 'a|b', 'a&b', 'a>b'
  ])('refused: %j', (b) => expect(validBranch(b)).toBe(false));
});

describe('validateGhArgs', () => {
  test('only `pr view <branch> --json <fixed fields>`', () => {
    expect(ghArgs('feature/x')).toEqual(['pr', 'view', 'feature/x', '--json', PR_FIELDS]);
    expect(() => validateGhArgs(ghArgs('feature/x'))).not.toThrow();
  });
  test.each([
    [['pr', 'view', 'feature/x', '--json', 'number']],
    [['pr', 'view', 'feature/x', '--json', PR_FIELDS, '--web']],
    [['pr', 'view', '--web', '--json', PR_FIELDS]],
    [['pr', 'view', 'a;rm -rf', '--json', PR_FIELDS]],
    [['pr', 'view', 'a b', '--json', PR_FIELDS]],
    [['pr', 'view', '-R', '--json', PR_FIELDS]],
    [['pr', 'view', 'a..b', '--json', PR_FIELDS]],
    [['pr', 'merge', 'feature/x', '--json', PR_FIELDS]],
    [['api', 'user']], [['auth', 'token']], [['pr', 'view', 'feature/x']], [[]]
  ])('refused: %j', (a) => expect(() => validateGhArgs(a)).toThrow());
});

// POSIX: POSIX PATH fixtures through node:path.
posixTest('findGh: the test fake first (when given), then PATH, then Homebrew and /usr/local even with the Finder\'s minimal PATH', () => {
  const all = (p: string) => ['/my/bin/gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'].includes(p);
  expect(findGh('/my/bin:/usr/bin', all, '/fake/gh')).toBe('/fake/gh');
  expect(findGh('/my/bin:/usr/bin', all)).toBe('/my/bin/gh');
  expect(findGh('/usr/bin:/bin', all)).toBe('/opt/homebrew/bin/gh');
  expect(findGh('/usr/bin:/bin', (p) => p === '/usr/local/bin/gh')).toBe('/usr/local/bin/gh');
  expect(findGh(undefined, () => false)).toBeNull();
  // Relative PATH entries are never searched (they would depend on the cwd: the repo).
  expect(findGh('.:bin', () => true, undefined)).toBe('/opt/homebrew/bin/gh');
});

test('findGh on Windows: gh.exe in PATH, then the installer\'s folder', () => {
  const at = (...ok: string[]) => (p: string) => ok.includes(p);
  expect(findGh('C:\\Windows;C:\\tools', at('C:\\tools\\gh.exe'), undefined, 'win32')).toBe('C:\\tools\\gh.exe');
  expect(findGh('C:\\Windows', at('C:\\Program Files\\GitHub CLI\\gh.exe'), undefined, 'win32')).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
  expect(findGh('bin', () => false, undefined, 'win32')).toBeNull();
});

test('ghEnv: no prompts, colors or update checks; GH_REPO and debug output not passed through; HOME and PATH kept', () => {
  const env = ghEnv({ HOME: '/h', PATH: '/usr/bin', GH_REPO: 'evil/repo', GH_DEBUG: '1', GH_HOST: 'ghe.example.com', GH_TOKEN: 't' });
  expect(env.HOME).toBe('/h');
  expect(env.PATH).toBe('/usr/bin');
  expect(env.GH_REPO).toBeUndefined();
  expect(env.GH_DEBUG).toBeUndefined();
  expect(env.GH_HOST).toBe('ghe.example.com');
  expect(env.GH_TOKEN).toBe('t');
  expect(env).toMatchObject({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1' });
});

test('minor 5: ghEnv drops inherited GIT_* (another repo, index, config…) and never lets git prompt', () => {
  const env = ghEnv({ HOME: '/h', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_INDEX_FILE: '/x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.sshCommand', GIT_CONFIG_VALUE_0: 'evil', GIT_TERMINAL_PROMPT: '1' });
  expect(Object.keys(env).filter((k) => k.startsWith('GIT_'))).toEqual(['GIT_TERMINAL_PROMPT']);
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  expect(env.HOME).toBe('/h');
});

test('classifyGhFailure', () => {
  expect(classifyGhFailure('ENOENT', '')).toBe('missing');
  expect(classifyGhFailure(1, 'To get started with GitHub CLI, please run:  gh auth login')).toBe('auth');
  expect(classifyGhFailure(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe('auth');
  expect(classifyGhFailure(4, 'authentication required')).toBe('auth');
  expect(classifyGhFailure(1, 'no pull requests found for branch "feature/x"')).toBe('none');
  expect(classifyGhFailure(1, 'none of the git remotes configured for this repository point to a known GitHub host')).toBe('none');
  expect(classifyGhFailure(null, 'timeout')).toBe('error');
});

// I-4: a repo that isn't on GitHub (gh's message even names `gh auth login`) is that repo's "no PR", never the global
// "not logged in" — which would hide every chip and show the Settings notice.
describe('classifyGhFailure: gh\'s own messages', () => {
  test.each([
    ['none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`', 'none'],
    ['no git remotes found', 'none'],
    ['failed to run git: fatal: not a git repository (or any of the parent directories): .git', 'none'],
    ['no pull requests found for branch "feature/x"', 'none'],
    ['To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.', 'auth'],
    ['You are not logged into any GitHub hosts. To log in, run: gh auth login', 'auth'],
    ['HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login', 'auth'],
    ['HTTP 401: Requires authentication (https://api.github.com/graphql)', 'auth'],
    ['error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'error'],
    ['GraphQL: API rate limit exceeded for user ID 1.', 'error']
  ])('%j → %s', (stderr, kind) => expect(classifyGhFailure(1, stderr)).toBe(kind));
});

describe('viewPr', () => {
  const ok = JSON.stringify({ number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: null, statusCheckRollup: [] });
  const fake = (r: { err?: { code?: string | number | null; message?: string } | null; stdout?: string; stderr?: string }) => {
    const calls: { file: string; args: string[]; opts: Parameters<GhExec>[2] }[] = [];
    const exec: GhExec = (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      const err = r.err ? Object.assign(new Error(r.err.message ?? 'failed'), { code: r.err.code }) : null;
      cb(err, r.stdout ?? '', r.stderr ?? '');
    };
    return { exec, calls };
  };

  test('runs the found gh in the repo root with the fixed argv, a 15 s timeout and a 1 MB cap', async () => {
    const f = fake({ stdout: ok });
    const r = await viewPr('/repo', 'feature/x', { exec: f.exec, find: () => '/bin/gh' });
    expect(r).toEqual({ kind: 'ok', pr: expect.objectContaining({ number: 7, url: 'https://github.com/o/r/pull/7' }) });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.file).toBe('/bin/gh');
    expect(f.calls[0]!.args).toEqual(['pr', 'view', 'feature/x', '--json', PR_FIELDS]);
    expect(f.calls[0]!.opts).toMatchObject({ cwd: '/repo', timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(f.calls[0]!.opts.env.GH_PROMPT_DISABLED).toBe('1');
  });

  test('no gh found → missing without running anything; ENOENT → missing', async () => {
    const f = fake({ stdout: ok });
    expect(await viewPr('/repo', 'feature/x', { exec: f.exec, find: () => null })).toEqual({ kind: 'missing' });
    expect(f.calls).toHaveLength(0);
    expect((await viewPr('/repo', 'feature/x', { exec: fake({ err: { code: 'ENOENT' } }).exec, find: () => '/bin/gh' })).kind).toBe('missing');
  });

  test('auth, none, other errors and unparsable output', async () => {
    const run = (r: Parameters<typeof fake>[0]) => viewPr('/repo', 'feature/x', { exec: fake(r).exec, find: () => '/bin/gh' });
    expect((await run({ err: { code: 4 }, stderr: 'gh auth login' })).kind).toBe('auth');
    expect((await run({ err: { code: 1 }, stderr: 'no pull requests found for branch "feature/x"' })).kind).toBe('none');
    expect((await run({ err: { code: 1 }, stderr: 'something else' })).kind).toBe('error');
    expect((await run({ stdout: '{"number":"x"}' })).kind).toBe('error');
  });

  test('a bad branch or relative root is refused before running', async () => {
    const f = fake({ stdout: ok });
    expect((await viewPr('/repo', '-x', { exec: f.exec, find: () => '/bin/gh' })).kind).toBe('error');
    expect((await viewPr('repo', 'feature/x', { exec: f.exec, find: () => '/bin/gh' })).kind).toBe('error');
    expect(f.calls).toHaveLength(0);
  });
});
