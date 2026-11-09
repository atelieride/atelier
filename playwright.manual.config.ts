import { defineConfig } from '@playwright/test';
// globalSetup: one e2e run at a time on this Mac (a lock in the git common dir; ATELIER_E2E_NO_LOCK=1 skips it), then
// the run works inside its own temp root (atl-run-*), removed at the end (tests/support/global-e2e.ts, temp-root.ts).
export default defineConfig({ testDir: 'tests/e2e', testMatch: ['**/*.manual.ts'], timeout: 240000, workers: 1, outputDir: 'test-results', globalSetup: './tests/support/global-e2e.ts' });
