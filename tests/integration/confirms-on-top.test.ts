import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Main's questions and the unsaved files' sheet are never hidden under another sheet: they take
// the focus (Enter answers them), so a question drawn under a later sheet would be answered blind. Every window mounts
// its confirms last, and their layer sits above every other layer of the interface.
const src = (p: string) => readFileSync(join(__dirname, '../../src/renderer', p), 'utf8');

test('each window mounts its confirms after every other sheet', () => {
  // The project window: the last element of its tree.
  expect(src('App.tsx')).toMatch(/<Confirms \/>\n {4}<\/div>\n {2}\);\n\}/);
  // The welcome window: last too.
  expect(src('App.tsx')).toMatch(/<Confirms \/><\/>;/);
  // A pop-out.
  expect(src('components/PopoutWindow.tsx')).toMatch(/<Confirms \/>\n {4}<\/div>\n {2}\);\n\}/);
});

const cssFiles = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith('.css') ? [p] : [];
});

test('the confirms\' layer is above every other layer', () => {
  const layout = src('layout.css');
  const confirm = Number(/^\.palette-backdrop:has\(> \.confirm-sheet\) \{[^}]*z-index: (\d+)/m.exec(layout)?.[1]);
  expect(confirm).toBeGreaterThan(0);
  const others = cssFiles(join(__dirname, '../../src/renderer')).flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .filter((l) => !l.startsWith('.palette-backdrop:has(> .confirm-sheet)'))
    .flatMap((l) => [...l.matchAll(/z-index: (\d+)/g)].map((m) => Number(m[1])));
  expect(others.length).toBeGreaterThan(10);
  expect(Math.max(...others)).toBeLessThan(confirm);
});
