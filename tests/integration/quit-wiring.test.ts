import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// A quit a kept page called off (Cancel on the unsaved question, after Windows' shutdown or a confirmed quit) is no
// longer confirmed: the next ⌘Q asks again about running git writes (bug hunt 2026-10-22).
test('a page that keeps the app open un-confirms the quit', () => {
  const src = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8');
  const body = /const quitStopped = \(\) => \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? '';
  expect(body).toMatch(/quitConfirmed = false;/);
});
