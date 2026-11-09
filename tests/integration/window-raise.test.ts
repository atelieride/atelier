import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// In e2e the windows must never cover the user's work: every show/focus/raise of a window goes through
// hidden-windows.ts (a no-op under the test flag). Any other call to one of these in src/main is a leak.
const mainDir = join(__dirname, '../../src/main');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
});
// Calls that are not windows, with the reason they are fine.
const allowed: Record<string, string> = {
  'note.show()': 'an OS Notification (terminal-hub), diverted to ATELIER_TEST_NOTIFY_LOG in e2e'
};

test('windows are shown, focused or raised only through hidden-windows.ts', () => {
  const raise = /\S*?\??\.(show|showInactive|focus|moveTop|restore)\(\s*\)/g;
  const offenders = files(mainDir).filter((p) => !p.endsWith('hidden-windows.ts')).flatMap((p) =>
    [...readFileSync(p, 'utf8').matchAll(raise)].map((m) => m[0]).filter((call) => !(call in allowed))
      .map((call) => `${p.slice(mainDir.length + 1)}: ${call}`));
  expect(offenders).toEqual([]);
});

test('the hidden-window Chromium switches are appended only through hidden-windows.ts', () => {
  const offenders = files(mainDir).filter((p) => !p.endsWith('hidden-windows.ts'))
    .filter((p) => /disable-(renderer-backgrounding|backgrounding-occluded-windows|background-timer-throttling)|backgroundThrottling/.test(readFileSync(p, 'utf8')));
  expect(offenders.map((p) => p.slice(mainDir.length + 1))).toEqual([]);
});
