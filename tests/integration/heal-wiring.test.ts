import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Equal lists are no longer re-sent, so a terminal opened locally is checked against
// main's list a moment later (one that exited during its create would otherwise stay as a ghost tab).
test('the store checks a terminal it added locally against main\'s list', () => {
  const src = readFileSync(join(__dirname, '../../src/renderer/store.ts'), 'utf8');
  expect(src).toMatch(/healAfterOpen\(info\.id, \{ list: \(\) => window\.atelier\.terminals\.list\(\)/);
});
