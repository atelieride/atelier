import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Session panel: its commands must never send a draft along. Drafts are followed in
// src/renderer/terminal/drafts.ts, which only works if every write to a terminal goes through its sendInput — but the
// panel's own commands (no draft of the user's).
const root = join(__dirname, '../../src/renderer');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
});

test('every write to a terminal goes through sendInput, but the Session panel\'s own commands', () => {
  const direct = files(root).filter((p) => readFileSync(p, 'utf8').includes('terminals.input(')).map((p) => posixRel(root, p)).sort();
  expect(direct).toEqual(['session-panel.ts', 'terminal/drafts.ts']);
});
