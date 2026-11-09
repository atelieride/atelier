import { defineConfig } from '@playwright/test';
// The *.manual.ts checks use the real Claude Code (they consume usage): run them only with playwright.manual.config.ts.
// globalSetup: one e2e run at a time on this Mac (a lock in the git common dir; ATELIER_E2E_NO_LOCK=1 skips it), then
// the run works inside its own temp root (atl-run-*), removed at the end (tests/support/global-e2e.ts, temp-root.ts).
// reporter: list (one line per finished test), plus the full-green stamp of a green full run (full-green-reporter.ts).
// workers: 2 — a worker costs ~0.7 GB (an Electron, an atelierd, its shells) and the lock keeps one run on the Mac.
// Measured: 2 workers run at ~1.8× with no swap growth.
export default defineConfig({ testDir: 'tests/e2e', timeout: 60000, workers: 2, outputDir: 'test-results', testIgnore: ['**/*.manual.ts'], globalSetup: './tests/support/global-e2e.ts', reporter: [['list'], ['./tests/support/full-green-reporter.ts']] });
