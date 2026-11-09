import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { posixOnlyExcludes } from './tests/support/posix-only';
import { testTimeoutFor } from './tests/support/timeouts';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    environment: 'node',
    // The theme's tokens are read as text (shared/theme-resolve.ts): without this, vitest hands every CSS file over empty.
    css: { include: [/themes?(?:-docsy)?\.css/] },
    include: ['src/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/support/**/*.test.ts'],
    // Windows leaves out the files that need POSIX as a whole (tests/support/posix-only.ts, with the reasons).
    exclude: [...configDefaults.exclude, ...posixOnlyExcludes(process.platform)],
    // 20 s; a minute on Windows, whose CI runner has slow spells (tests/support/timeouts.ts).
    testTimeout: testTimeoutFor(process.platform),
    pool: 'forks',
    setupFiles: ['tests/setup-env.ts'],
    globalSetup: ['tests/support/global-temp-root.ts', 'tests/support/global-electron.ts']
  }
});
