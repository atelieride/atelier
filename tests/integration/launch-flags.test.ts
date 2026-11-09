import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Launch flags: automations never take them. Their command is built in src/main/automations from
// the automation's own model and mode; nothing there may read the user's flags.

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});

test('automations never read the launch flags', () => {
  const found = files('src/main/automations').filter((p) => /claudeFlags|claude-flags|launchFlags|sessionCommand/.test(readFileSync(p, 'utf8')));
  expect(found).toEqual([]);
});
