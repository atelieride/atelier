import { tmpdir } from 'node:os';
import { TEMP_VARS, createRunTemp, removeRunTemp } from './temp-root';
import { bootOutRunJobs, stopRunDaemons } from './stop-daemons';

// Global setup of vitest and Playwright: the whole run works inside its own temp root, removed at the end
// (tests/support/temp-root.ts). It runs before any worker starts (vitest forks, Playwright workers), so they inherit
// TMPDIR (TEMP and TMP on Windows) and every os.tmpdir() in a test, Electron or atelierd lands there. The returned
// function is the teardown (both runners take it).
export default function globalTempRoot(): () => void {
  const saved = TEMP_VARS.map((v) => [v, process.env[v]] as const);
  const base = tmpdir();
  const dir = createRunTemp(base);
  return () => {
    // Test atelierds left running would outlive the run (and its removed folder).
    stopRunDaemons(dir);
    // Their launchd jobs too (atelierd's, the terminals'): only labels hashed from this run's homes.
    bootOutRunJobs(dir);
    removeRunTemp(dir, base);
    for (const [v, value] of saved) if (value === undefined) delete process.env[v]; else process.env[v] = value;
  };
}
