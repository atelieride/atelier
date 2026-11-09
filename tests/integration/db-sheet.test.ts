// Add / Edit Connection and Remove: loaded when one opens, never with the first paint
// (the live demo's budget), in the project window and in a pop-out; drawn with databases.css, laid out to
// hold at every width — the body scrolls inside a sheet never taller than the window, the buttons stay in view, names
// and hosts ellipsize in their field, chips and segments never wrap.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const src = (p: string) => readFileSync(join(RENDERER, p), 'utf8');
const css = src('databases.css').replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of every rule that names `sel` among its selectors, joined. */
const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');

test('each window mounts the host, under its confirms', () => {
  for (const [f, from] of [['App.tsx', './databases/DbSheetsHost'], ['components/PopoutWindow.tsx', '../databases/DbSheetsHost']] as const) {
    const code = src(f);
    expect(code, f).toContain(`import { DbSheetsHost } from '${from}';`);
    expect(code.match(/<DbSheetsHost \/>/g), f).toHaveLength(1);
    expect(code.indexOf('<DbSheetsHost />'), f).toBeLessThan(code.lastIndexOf('<Confirms />'));
  }
});

test('the first paint never reaches the sheet\'s modules statically, nor the shared model but its types', () => {
  const firstPaint = ['App.tsx', 'components/PopoutWindow.tsx', 'components/Sidebar.tsx', 'components/Tabs.tsx', 'components/ActivityBar.tsx',
    'components/PaneHeader.tsx', 'store.ts', 'move-window.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts', 'databases/install.ts',
    'databases/DbSheetsHost.tsx'];
  for (const f of firstPaint) {
    const code = src(f);
    expect(code, f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(ConnectionSheet|form)'/m);
    // The engine table, the providers and the helpers stay with the lazy chunks: the empty snapshot has its own module.
    expect(code, f).not.toMatch(/^import (?!type )[^;]*from '@shared\/databases'/m);
  }
  expect(src('databases/store.ts')).toMatch(/^import \{ EMPTY_DB_SNAPSHOT \} from '@shared\/databases-empty';$/m);
  expect(readFileSync(join(RENDERER, '..', 'demo', 'bridge', 'inert.ts'), 'utf8')).not.toMatch(/^import (?!type )[^;]*from '@shared\/databases'/m);
  // It brings the view's stylesheet itself: it can open before the sidebar's chunk ever loaded.
  expect(src('databases/ConnectionSheet.tsx')).toMatch(/^import '\.\.\/databases\.css';$/m);
});

test('the sheet is never taller than the window: its body scrolls, its head and buttons stay', () => {
  expect(rule('.palette.git-sheet.db-sheet')).toMatch(/max-height: calc\(100vh - \d+px\)/);
  expect(rule('.palette.git-sheet.db-sheet')).toMatch(/width: min\(\d+px, calc\(100vw - \d+px\)\)/);
  expect(rule('.db-sheet-body')).toMatch(/min-height: 0/);
  expect(rule('.db-sheet-body')).toMatch(/overflow-y: auto/);
  expect(rule('.db-sheet-foot')).toMatch(/flex: none/);
  expect(rule('.db-sheet > .git-sheet-head')).toMatch(/flex: none/);
});

test('fields never overlap: grids of shrinking columns, inputs that shrink, chips and tags whole', () => {
  expect(rule('.db-grid')).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  expect(rule('.db-input')).toMatch(/min-width: 0/);
  expect(rule('.db-input > input')).toMatch(/min-width: 0/);
  expect(rule('.db-input > input')).toMatch(/flex: 1/);
  for (const sel of ['.db-chip', '.db-input-tag', '.db-later']) {
    expect(rule(sel), sel).toMatch(/flex: none/);
    expect(rule(sel), sel).toMatch(/white-space: nowrap/);
  }
});

test('names truncate with an ellipsis: segments, engine cards, the read-only line', () => {
  for (const sel of ['.db-seg-label', '.db-engine-text > b', '.db-engine-text > span', '.db-sheet-lock > span', '.db-input-tag > span']) {
    const r = rule(sel);
    expect(r, sel).toMatch(/min-width: 0/);
    expect(r, sel).toMatch(/overflow: hidden/);
    expect(r, sel).toMatch(/text-overflow: ellipsis/);
    expect(r, sel).toMatch(/white-space: nowrap/);
  }
  // Segments shrink rather than push the sheet wider; a whole group never goes past its field.
  expect(rule('.db-seg')).toMatch(/max-width: 100%/);
  expect(rule('.db-seg .set-seg-opt')).toMatch(/min-width: 0/);
  // Engine cards: as many columns as fit; the "Later" badge in the flow, never over the label.
  expect(rule('.db-engines')).toMatch(/repeat\(auto-fill, minmax\(\d+px, 1fr\)\)/);
  expect(rule('.db-later')).not.toMatch(/position: absolute/);
  // A server line or an error detail breaks rather than spill out.
  expect(rule('.db-sheet-note-mono')).toMatch(/overflow-wrap: anywhere/);
  // The TLS hint goes under the modes when out of room.
  expect(rule('.db-tls')).toMatch(/flex-wrap: wrap/);
  expect(rule('.db-sheet-foot')).toMatch(/flex-wrap: wrap/);
});

test('production\'s segment in the theme\'s danger color; the answers in their tone', () => {
  expect(rule('.db-seg .set-seg-opt.is-prod.is-on')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-seg-dot.is-prod')).toMatch(/background: var\(--error\)/);
  expect(rule('.db-sheet-note.is-ok')).toMatch(/var\(--edge-done\)/);
  expect(rule('.db-sheet-note.is-err')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-sheet-warn')).toMatch(/color: var\(--waiting\)/);
  expect(rule('.db-input.is-invalid')).toMatch(/var\(--edge-error\)/);
  expect(rule('.db-field-err')).toMatch(/color: var\(--text-error\)/);
});

test('everything the user can press answers hover and focus', () => {
  expect(rule('.db-engine:focus-visible')).toMatch(/var\(--focus-ring\)/);
  expect(rule('.db-sect:focus-visible')).toMatch(/var\(--violet\)/);
  // The picked engine: the app's flat selection (quiet finish), never a wash or a halo.
  expect(rule('.db-engine.is-on')).toMatch(/background: var\(--bg-sel\)/);
  expect(rule('.db-engine.is-on')).not.toMatch(/gradient|--glow/);
  expect(rule('.db-engine:hover:not(:disabled)')).toMatch(/box-shadow/);
  expect(rule('.db-sect:hover')).toMatch(/box-shadow/);
  expect(rule('.db-input:focus-within')).toMatch(/var\(--violet-soft\)/);
});
