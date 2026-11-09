import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// Ask is on every platform (the Windows gate is lifted once its
// Windows path forms were verified on the test PC). The pure entry points have win32 tests of their own (the menus, the
// Windows menu, Settings › Keyboard, the slice, main's IPC); the components below only render, so each is pinned here
// to render Ask with no condition of its own between it and the user.

const root = join(__dirname, '../..');
const src = (rel: string) => readFileSync(join(root, 'src/renderer', rel), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

test('every component entry point of Ask renders it on every platform', () => {
  const shown: [string, RegExp][] = [
    // The session bar's pill.
    ['components/SessionBar.tsx', /^\s*<AskButton term=\{term\} \/>$/m],
    // The sidebar's mark.
    ['components/SessionRow.tsx', /const askMark = useApp\(\(st\) => \{\n\s*const unseen = /],
    // The palette's Ask About This Session and its "Ask about" rows.
    ['components/Palette.tsx', /const askThis = selected && \(selected\.session \|\| st\.askOpen\[selected\.id\]\)/],
    ['components/Palette.tsx', /\n\s*if \(\(q\.mode === 'all' \|\| q\.mode === 'commands'\) && text\) \{\n\s*const popped = /],
    // Settings › Ask.
    ['components/Settings.tsx', /\{ id: 'ask', icon: 'ask' \}/],
    ['components/Settings.tsx', /\{section === 'ask' && <AskSettings s=\{s\} \/>\}/],
    // The host (a binding restored after a restart or carried by a pop-out shows).
    ['components/companion/AskHost.tsx', /return binding \? <OpenHost binding=\{binding\} place=\{place\} \/> : null;/]
  ];
  for (const [file, re] of shown) expect(src(file), `${file}: ${re}`).toMatch(re);
});

test('no platform gate for Ask is left in the renderer', () => {
  const gated = walk(join(root, 'src/renderer')).filter((f) => /\baskCompanion\b/.test(readFileSync(f, 'utf8'))).map((f) => posixRel(root, f));
  expect(gated).toEqual([]);
});
