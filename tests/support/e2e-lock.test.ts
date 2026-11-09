// One e2e run at a time on the machine, whatever checkout or worktree it starts from.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lockFile, pidAlive, releaseLock, takeLock, type LockInfo } from './e2e-lock';

const MIN = 60_000;
const dir = () => mkdtempSync(join(tmpdir(), 'e2e-lock-'));
const info = (pid: number, at = 0, cwd = '/repo/.claude/worktrees/x'): LockInfo => ({ pid, startedAt: at, cwd, what: 'playwright test' });

/** A fake clock that sleep() advances; `onSleep` runs after each sleep (the other run finishing, say). */
function clock(onSleep: (n: number) => void = () => {}) {
  let t = 10 * MIN;
  let n = 0;
  const lines: string[] = [];
  return {
    lines,
    opts: {
      now: () => t,
      sleep: async (ms: number) => { t += ms; onSleep(++n); },
      log: (l: string) => lines.push(l),
      root: '/repo'
    }
  };
}

test('a free lock is taken at once, with who holds it', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  const c = clock();
  await takeLock(p, info(process.pid, 10 * MIN), { ...c.opts, isAlive: () => true });
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(info(process.pid, 10 * MIN));
  expect(c.lines).toEqual([]);
});

test('a lock held by a live run waits, says so every 30 s, and is taken once released', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(123, 6 * MIN)));
  const c = clock((n) => { if (n === 65) releaseLock(p, 123); }); // released after 65 s of 1 s polls
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: (pid) => pid === 123 && existsSync(p) });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid);
  expect(c.lines[0]).toBe('Waiting for the e2e run started 4 min ago in .claude/worktrees/x (pid 123)…');
  expect(c.lines).toHaveLength(3); // at 0 s, 30 s, 60 s
  expect(c.lines[1]).toMatch(/started 4 min ago/);
  expect(c.lines[2]).toMatch(/started 5 min ago/);
});

test('the main checkout is named as such, a run just started says so', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(123, 10 * MIN - 5000, '/repo')));
  const c = clock((n) => { if (n === 1) releaseLock(p, 123); });
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: () => existsSync(p) });
  expect(c.lines[0]).toBe('Waiting for the e2e run started less than a minute ago in the main checkout (pid 123)…');
});

test('a lock whose pid is gone is stale: removed with a line, then taken', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(999_999, 0)));
  const c = clock();
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: () => false });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid);
  expect(c.lines).toEqual(['Removed a stale e2e lock: pid 999999 (started in .claude/worktrees/x) is gone.']);
});

test('an unreadable lock is waited on briefly (being written), then treated as stale', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, '{"pid": 12');
  const c = clock();
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: () => true, fileAge: () => (c.opts.now() - 10 * MIN) });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid);
  expect(c.lines).toEqual(['Removed an unreadable e2e lock.']);
});

test('only its owner releases the lock', () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(123)));
  expect(releaseLock(p, 456)).toBe(false);
  expect(existsSync(p)).toBe(true);
  expect(releaseLock(p, 123)).toBe(true);
  expect(existsSync(p)).toBe(false);
  expect(releaseLock(p, 123)).toBe(false); // already gone
});

test('the lock lives in the git common dir, shared by every worktree; outside git there is none', () => {
  const root = join(__dirname, '../..');
  const p = lockFile(root);
  expect(p).toMatch(/[\\/]\.git[\\/]atelier-e2e\.lock$/);
  expect(lockFile(dir())).toBeNull();
});

test('pidAlive: this process is, an unused pid is not', () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});

// Two waiters that both saw the same stale lock must not both remove "it" (the second would remove the
// first one's fresh lock). Removal happens under an exclusive guard file, with the lock read again inside it.
test('a stale lock is removed only under the guard, and a fresh guard makes the waiter wait instead', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(999_999, 0)));
  const seen: boolean[] = [];
  const c = clock();
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: () => false, beforeStaleRemoval: () => seen.push(existsSync(`${p}.stale`)) });
  expect(seen).toEqual([true]);
  expect(existsSync(`${p}.stale`)).toBe(false);

  writeFileSync(p, JSON.stringify(info(999_999, 0)));
  writeFileSync(`${p}.stale`, '');
  const c2 = clock((n) => { if (n === 3) rmSync(`${p}.stale`); }); // the other waiter finishes its removal
  await takeLock(p, info(process.pid + 1), { ...c2.opts, isAlive: () => false, fileAge: () => 0 });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid + 1);
});

test('the lock read again under the guard wins: a lock another run wrote meanwhile is left alone', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(999_999, 0)));
  const c = clock((n) => { if (n === 2) releaseLock(p, 123); });
  // The other waiter won the race: by the time we hold the guard, the lock is its (live) one.
  await takeLock(p, info(process.pid), {
    ...c.opts,
    isAlive: (pid) => pid === 123,
    beforeStaleRemoval: () => writeFileSync(p, JSON.stringify(info(123, 0)))
  });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid);
  expect(c.lines.some((l) => l.startsWith('Removed a stale'))).toBe(false);
  expect(c.lines.some((l) => l.includes('(pid 123)'))).toBe(true);
});

test('a guard left by a crashed waiter (older than 10 s) is cleared', async () => {
  const p = join(dir(), 'atelier-e2e.lock');
  writeFileSync(p, JSON.stringify(info(999_999, 0)));
  writeFileSync(`${p}.stale`, '');
  const c = clock();
  await takeLock(p, info(process.pid), { ...c.opts, isAlive: () => false, fileAge: (f) => (f.endsWith('.stale') ? 11_000 : 0) });
  expect(JSON.parse(readFileSync(p, 'utf8')).pid).toBe(process.pid);
});
