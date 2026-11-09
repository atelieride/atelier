import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The run works inside its own temp root, removed at the end (tests/support/temp-root.ts), like the app's tests. The
// app's code it reaches (the temp root, the demo protocol) resolves `@shared` as the app's own config does.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, '../src/shared') } },
  test: { include: ['tests/**/*.test.ts'], globalSetup: ['../tests/support/global-temp-root.ts'] }
});
