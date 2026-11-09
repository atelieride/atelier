// Playwright's global setup takes the e2e lock, then makes the run's temp root; its teardown
// cleans the temp root (daemons, launchd jobs) first and only then lets the next run in. vitest never takes the lock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeGlobalE2e } from './global-e2e';

function fakes(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const exits: (() => void)[] = [];
  const deps = {
    env: {} as NodeJS.ProcessEnv,
    cwd: '/repo/.claude/worktrees/x',
    pid: 4242,
    argv: ['node', 'playwright', 'test', 'tests/e2e/find-replace.spec.ts'],
    now: () => 1000,
    log: (l: string) => calls.push(`log ${l}`),
    lockFile: () => '/repo/.git/atelier-e2e.lock',
    takeLock: async (p: string, i: { pid: number; what: string; cwd: string; startedAt: number }) => { calls.push(`take ${p} ${i.pid} ${i.what} ${i.cwd} ${i.startedAt}`); },
    releaseLock: (p: string, pid: number) => { calls.push(`release ${p} ${pid}`); return true; },
    tempRoot: () => { calls.push('temp root'); return () => calls.push('temp root teardown'); },
    onExit: (f: () => void) => exits.push(f),
    ...over
  };
  return { calls, exits, deps };
}

test('takes the lock before the temp root; releases it after the temp root teardown', async () => {
  const { calls, deps } = fakes();
  const teardown = await makeGlobalE2e(deps)();
  expect(calls).toEqual(['take /repo/.git/atelier-e2e.lock 4242 playwright test tests/e2e/find-replace.spec.ts /repo/.claude/worktrees/x 1000', 'temp root']);
  await teardown();
  expect(calls.slice(2)).toEqual(['temp root teardown', 'release /repo/.git/atelier-e2e.lock 4242']);
});

test('the lock goes on exit too (Ctrl-C, a crash before teardown)', async () => {
  const { calls, exits, deps } = fakes();
  await makeGlobalE2e(deps)();
  expect(exits).toHaveLength(1);
  exits[0]!();
  expect(calls.at(-1)).toBe('release /repo/.git/atelier-e2e.lock 4242');
});

test('ATELIER_E2E_NO_LOCK=1 skips the lock, says so, still makes the temp root', async () => {
  const { calls, deps } = fakes({ env: { ATELIER_E2E_NO_LOCK: '1' } });
  const teardown = await makeGlobalE2e(deps)();
  await teardown();
  expect(calls).toEqual(['log e2e lock skipped (ATELIER_E2E_NO_LOCK=1).', 'temp root', 'temp root teardown']);
});

test('outside a git checkout there is no lock, and it says so', async () => {
  const { calls, deps } = fakes({ lockFile: () => null });
  const teardown = await makeGlobalE2e(deps)();
  await teardown();
  expect(calls).toEqual(['log Not in a git checkout: no e2e lock.', 'temp root', 'temp root teardown']);
});

test('both Playwright configs use it; vitest keeps the plain temp root (unit tests never wait on an e2e)', () => {
  const root = join(__dirname, '../..');
  for (const f of ['playwright.config.ts', 'playwright.manual.config.ts']) {
    expect(readFileSync(join(root, f), 'utf8')).toContain("globalSetup: './tests/support/global-e2e.ts'");
  }
  const vitest = readFileSync(join(root, 'vitest.config.ts'), 'utf8');
  expect(vitest).toContain("globalSetup: ['tests/support/global-temp-root.ts', ");
  expect(vitest).not.toContain('global-e2e');
});
