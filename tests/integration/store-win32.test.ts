import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { NO_IDENTITY, parseHelperError } from '../../src/shared/store-updates';
import { helperRunner } from '../../src/main/store-exec';
import { StoreUpdater } from '../../src/main/store-updates';
import { isWin } from '../support/platform';

// atelier-store.exe for real: outside a package (this test, a dev run)
// it has no identity, says so, and the updater then reports Store updates as not available. Needs the binary
// (`npm run build` on Windows).

const BIN = resolve('vendor', 'bin', 'atelier-store.exe');

test.runIf(isWin)('without package identity: the no-identity error, and the updater turns itself off', async () => {
  const runner = helperRunner(BIN);
  const r = await runner.check();
  expect(r.code).toBe(1);
  expect(parseHelperError(r.out)?.hresult).toBe(NO_IDENTITY);
  const u = new StoreUpdater({ version: '0.2.0-beta.21', build: 26100, runner, now: () => 1, log: () => {}, onStatus: () => {} });
  await u.check();
  expect(u.status()).toMatchObject({ available: false, phase: { kind: 'idle' } });
});

test.runIf(isWin)('a verb it does not know is refused', () => {
  const r = spawnSync(BIN, ['install'], { encoding: 'utf8', windowsHide: true });
  expect(r.status).toBe(1);
  expect(r.stdout).toMatch(/^error 80070057 usage/);
});
