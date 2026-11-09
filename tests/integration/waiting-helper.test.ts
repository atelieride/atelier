// Whether a session waits for you has one definition (src/shared/session-view.ts: a permission or a question, or an
// older atelierd's unspecified wait; never the idle notice). The app must not read the raw state for it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

const root = join(__dirname, '..', '..');
// The reducer that sets the state, the helper that reads it, and the Bash attribution (a Bash command running or
// asking for its permission: the raw state is what it means).
const ALLOWED = new Set(['src/shared/session.ts', 'src/shared/session-view.ts', 'src/shared/bash-attribution.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

test("no raw `state === 'waiting'` outside the shared helper", () => {
  const offenders = ['src/main', 'src/renderer', 'src/shared', 'src/preload'].flatMap((d) => files(join(root, d)))
    .map((p) => posixRel(root, p))
    .filter((p) => !ALLOWED.has(p) && /state\s*[!=]==\s*'waiting'|'waiting'\s*[!=]==\s*\S*state\b/.test(readFileSync(join(root, p), 'utf8')));
  expect(offenders).toEqual([]);
});
