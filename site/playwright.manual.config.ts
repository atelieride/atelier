import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Screenshot-only checks: they write PNGs into test-results/ to be looked
// at and assert nothing of their own, with fixed waits for the motion to settle, so they stay out of `npm run e2e`.
// `npm run shots:demo` builds the site and runs them against the same preview server, in Chromium.
export default defineConfig({
  ...base,
  testMatch: ['**/*.manual.ts'],
  workers: 1,
  projects: base.projects?.filter((p) => p.name === 'chromium')
});
