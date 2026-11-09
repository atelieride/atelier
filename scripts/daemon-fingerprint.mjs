// Builds atelierd alone (as `electron-vite build` does, into a temporary folder) and prints the sha256 of its
// daemon.js: daemon.js is standalone (tests/integration/daemon-bundle.test.ts), so equal hashes on two commits mean
// the app would not ask for an atelierd restart between them. Used to prove that work meant to leave atelierd alone
// did: run it on main and on the branch, compare.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from 'electron-vite';
import { build } from 'vite';

const outDir = mkdtempSync(join(tmpdir(), 'atl-daemon-fp-'));
try {
  const { config } = await resolveConfig({ configFile: 'electron.vite.daemon.config.ts', logLevel: 'silent' }, 'build', 'production');
  const daemon = config.main;
  daemon.build = { ...daemon.build, outDir };
  await build(daemon);
  console.log(createHash('sha256').update(readFileSync(join(outDir, 'daemon.js'))).digest('hex'));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
