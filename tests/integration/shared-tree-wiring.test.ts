import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The ports hub, the background work scan and the Redis clients share one `ps -A` read.
test('every reader of the process table in main goes through the shared reader', () => {
  for (const f of ['src/main/index.ts', 'src/main/redis/main-deps.ts']) {
    const src = readFileSync(join(__dirname, '../..', f), 'utf8');
    expect(src, f).toContain('sharedProcessTree()');
    expect(src, f).not.toMatch(/readProcessTree\(\)/);
  }
});
