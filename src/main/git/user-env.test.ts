import { afterEach, expect, test, vi } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import type { FileStamp } from '../shell-env-fresh';
import { FAILED_RETRY_MS, UserEnv, captureBaseEnv, defaultUserEnv, fallbackEnv } from './user-env';

// Never the user's real zsh from a test: the capture fails as it does where there is no zsh (Windows).
vi.mock('../../daemon/shell-env', () => ({ captureShellEnv: () => ({ result: Promise.reject(new Error('spawn /bin/zsh ENOENT')), cancel: () => {} }) }));

afterEach(() => { vi.useRealTimers(); resetPlatformForTests(); });

test('Windows: no login shell to capture, the app’s own environment is the user’s (Start menu): captured, no note', async () => {
  initPlatform('win32');
  const r = await defaultUserEnv().get();
  expect(r.captured).toBe(true);
  expect(r.env.PATH).toBe(process.env.PATH);
});

const stamp = (mtimeMs: number, size = 10, ino = 1): FileStamp => ({ mtimeMs, size, ino });

/** Fakes for everything UserEnv touches: a capture whose outcomes the test decides, a file system, a clock. */
function setup(o: { timeoutMs?: number } = {}) {
  const fs: Record<string, FileStamp> = { '/h/.zshenv': stamp(100), '/h/.zshrc': stamp(200) };
  const clock = { now: 1_000_000 };
  const captures: { resolve(env: Record<string, string>): void; reject(err: Error): void }[] = [];
  const env = new UserEnv({
    capture: () => new Promise((resolve, reject) => { captures.push({ resolve, reject }); }),
    stat: async (p) => fs[p] ?? null,
    files: () => ['/h/.zshenv', '/h/.zprofile', '/h/.zshrc', '/h/.zlogin'],
    now: () => clock.now,
    fallback: () => ({ PATH: '/usr/bin:/bin', HOME: '/h' }),
    timeoutMs: o.timeoutMs
  });
  /** Lets pending stats and promise callbacks run. */
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { env, fs, clock, captures, settle };
}

test('lazy: nothing is captured until the first get', async () => {
  const s = setup();
  await s.settle();
  expect(s.captures).toHaveLength(0);
});

test('concurrent callers share one capture, and later calls reuse it while no startup file changed', async () => {
  const s = setup();
  const a = s.env.get();
  const b = s.env.get();
  await s.settle();
  const c = s.env.get();
  await s.settle();
  expect(s.captures).toHaveLength(1);
  s.captures[0]!.resolve({ PATH: '/opt/homebrew/bin:/usr/bin', NVM_DIR: '/h/.nvm' });
  for (const r of await Promise.all([a, b, c])) expect(r).toEqual({ env: { PATH: '/opt/homebrew/bin:/usr/bin', NVM_DIR: '/h/.nvm' }, captured: true });
  expect(await s.env.get()).toEqual({ env: { PATH: '/opt/homebrew/bin:/usr/bin', NVM_DIR: '/h/.nvm' }, captured: true });
  expect(s.captures).toHaveLength(1);
});

test('callers get their own copy: changing one does not change the capture', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.captures[0]!.resolve({ PATH: '/x' });
  (await first).env.PATH = '/changed';
  expect((await s.env.get()).env.PATH).toBe('/x');
});

test('a saved startup file (mtime, size or inode), a new one or a deleted one: the next call captures again', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.captures[0]!.resolve({ V: '1' });
  await first;
  const changes: (() => void)[] = [
    () => { s.fs['/h/.zshrc'] = stamp(300); },
    () => { s.fs['/h/.zshrc'] = stamp(300, 11); },
    () => { s.fs['/h/.zshrc'] = stamp(300, 11, 2); },
    () => { s.fs['/h/.zprofile'] = stamp(50); },
    () => { delete s.fs['/h/.zshenv']; }
  ];
  for (const [i, change] of changes.entries()) {
    change();
    const next = s.env.get();
    await s.settle();
    expect(s.captures).toHaveLength(i + 2);
    s.captures[i + 1]!.resolve({ V: String(i + 2) });
    expect(await next).toEqual({ env: { V: String(i + 2) }, captured: true });
  }
  // Unchanged since the last capture: reused.
  expect((await s.env.get()).env).toEqual({ V: String(changes.length + 1) });
  expect(s.captures).toHaveLength(changes.length + 1);
});

test('a file saved while the capture ran: the capture is used, the next call captures again', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.fs['/h/.zshrc'] = stamp(999);
  s.captures[0]!.resolve({ V: 'old' });
  expect((await first).env).toEqual({ V: 'old' });
  const second = s.env.get();
  await s.settle();
  expect(s.captures).toHaveLength(2);
  s.captures[1]!.resolve({ V: 'new' });
  expect((await second).env).toEqual({ V: 'new' });
});

test('a failed capture: the app environment with the common PATH folders, captured false', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.captures[0]!.reject(new Error('shell exited (1) without printing its environment'));
  const r = await first;
  expect(r.captured).toBe(false);
  expect(r.env.HOME).toBe('/h');
  expect(r.env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
});

test('a capture that never answers: the fallback after the timeout', async () => {
  vi.useFakeTimers();
  const s = setup({ timeoutMs: 10_000 });
  const first = s.env.get();
  await s.settle();
  expect(s.captures).toHaveLength(1);
  let done = false;
  void first.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await first).toMatchObject({ captured: false });
  expect((await first).env.PATH).toContain('/opt/homebrew/bin');
  // A late answer from the timed-out capture is not used.
  s.captures[0]!.resolve({ V: 'late' });
  await s.settle();
  expect((await s.env.get()).captured).toBe(false);
});

test('a failure is not retried on every op: only after a startup file changes, or after five minutes', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.captures[0]!.reject(new Error('boom'));
  await first;
  s.clock.now += FAILED_RETRY_MS - 1;
  expect((await s.env.get()).captured).toBe(false);
  expect(s.captures).toHaveLength(1);
  // A startup file changed: retried at once.
  s.fs['/h/.zshrc'] = stamp(300);
  const second = s.env.get();
  await s.settle();
  expect(s.captures).toHaveLength(2);
  s.captures[1]!.reject(new Error('boom again'));
  await second;
  // Unchanged files, five minutes later: retried.
  s.clock.now += FAILED_RETRY_MS;
  const third = s.env.get();
  await s.settle();
  expect(s.captures).toHaveLength(3);
  s.captures[2]!.resolve({ V: 'ok' });
  expect(await third).toEqual({ env: { V: 'ok' }, captured: true });
});

test('a failed recapture keeps the earlier capture in use (still the user\'s environment)', async () => {
  const s = setup();
  const first = s.env.get();
  await s.settle();
  s.captures[0]!.resolve({ V: 'earlier' });
  await first;
  s.fs['/h/.zshrc'] = stamp(300);
  const second = s.env.get();
  await s.settle();
  s.captures[1]!.reject(new Error('broken .zshrc'));
  expect(await second).toEqual({ env: { V: 'earlier' }, captured: true });
  // Not retried while the broken file stays as it is.
  expect(await s.env.get()).toEqual({ env: { V: 'earlier' }, captured: true });
  expect(s.captures).toHaveLength(2);
});

test('fallbackEnv: Homebrew and /usr/local first, then the app PATH, without duplicates', () => {
  expect(fallbackEnv({ PATH: '/usr/local/bin:/usr/bin', X: '1' })).toEqual({ PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin', X: '1' });
  expect(fallbackEnv({}).PATH).toBe('/opt/homebrew/bin:/usr/local/bin');
});

test('captureBaseEnv: like atelierd, no Atelier or Claude Code variables, the user\'s ZDOTDIR only, auto-update off', () => {
  const base = captureBaseEnv({ HOME: '/h', PATH: '/usr/bin', ATELIER_HOME: '/a', ATELIER_TEST_X: '1', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1', ZDOTDIR: '/h/.config/zsh' });
  expect(base.HOME).toBe('/h');
  expect(base.PATH).toBe('/usr/bin');
  expect(base.ZDOTDIR).toBe('/h/.config/zsh');
  expect(base.DISABLE_AUTO_UPDATE).toBe('true');
  for (const k of ['ATELIER_HOME', 'ATELIER_TEST_X', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE']) expect(base).not.toHaveProperty(k);
  expect(captureBaseEnv({ HOME: '/h' })).not.toHaveProperty('ZDOTDIR');
});
