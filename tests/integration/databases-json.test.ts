// The JSON tools: their stylesheet and code come with the table's lazy chunk, never the first paint; colors only
// through Aurora's tokens, no gradient fill or halo (the presence bar is a solid violet); selectors their own; and the
// layout rules that hold at every width — the inspector's 280 px, a 430 px split pane: the head and every tree line one
// line; the breadcrumb cut
// from its start (the leaf stays); keys and values ellipsized; a line's actions taking the value's tail, never over it;
// the bottom bar's code ellipsized, Copy never shrinking or wrapping; the Table view scrolling sideways. No module whose
// name differs from another's only by case (a case-insensitive disk). The e2e layout check measures the same on screen.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'json-tools.css');
const code = readFileSync(OWN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const table = readFileSync(join(RENDERER, 'databases', 'table.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f: string) => readFileSync(join(RENDERER, f), 'utf8');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}
function selectors(text: string): string[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...t.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
/** The declarations of every rule naming `sel` (inside @container blocks too), joined. */
const ruleIn = (css: string) => (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');
const rule = ruleIn(code);
const has = (sel: string, ...decls: string[]) => {
  for (const d of decls) expect(rule(sel), `${sel} { ${d} }`).toContain(d);
};

test('the stylesheet and the code travel with the table\'s lazy chunk; the first paint reaches neither', () => {
  for (const f of ['databases/JsonInspector.tsx', 'databases/ColumnMenu.tsx']) expect(src(f), f).toMatch(/^import '\.\/json-tools\.css';$/m);
  expect(src('styles.ts')).not.toContain('json-tools.css');
  expect(src('databases/Inspector.tsx')).toMatch(/^import \{ JsonInspector, openJsonView \} from '\.\/JsonInspector';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ ColumnMenuHost \} from '\.\/ColumnMenu';$/m);
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'popout-payload.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx', 'redis/view.ts', 'redis/RedisValue.tsx',
    'components/Icon.tsx', 'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(JsonInspector|ColumnMenu|json)'/m);
  // Its strings are the table's lazy ones.
  for (const f of ['databases/json.ts', ...VIEWS]) {
    expect(src(f), f).toMatch(/^import \{ tdt \} from '\.\.\/i18n\/db-table';$/m);
    expect(src(f), f).not.toMatch(/from '\.\.\/i18n\/en'/);
  }
});

const VIEWS = ['databases/JsonInspector.tsx', 'databases/JsonLine.tsx', 'databases/JsonTable.tsx', 'databases/JsonRaw.tsx', 'databases/ColumnMenu.tsx'];

test('the JSON view in parts: its lines, its Table and its Raw are modules of their own, in the same lazy chunk', () => {
  const view = src('databases/JsonInspector.tsx');
  expect(view).toMatch(/^import \{ Line, type RowActs \} from '\.\/JsonLine';$/m);
  expect(view).toMatch(/^import \{ JsonTable \} from '\.\/JsonTable';$/m);
  expect(view).toMatch(/^import \{ JsonRaw \} from '\.\/JsonRaw';$/m);
  expect(view).not.toMatch(/function (Line|Act|Table|Raw)\(/);
  for (const f of ['App.tsx', 'store.ts', 'databases/store.ts', 'databases/install.ts']) expect(src(f), f).not.toMatch(/Json(Line|Table|Raw)/);
});

test('Table and Raw keep their scroll keys: ↑/↓ scroll there, never move the inspector\'s rows', () => {
  for (const f of ['databases/JsonTable.tsx', 'databases/JsonRaw.tsx']) {
    expect(src(f), f).toMatch(/onKeyDown=\{\(e\) => \{ if \(scrollKey\(e\.key\)\) e\.stopPropagation\(\); \}\}/);
  }
});

test('lossless all the way: no JSON.parse of a value; the trees are json-text.ts\'s, Redis\'s JsonNum leaves', () => {
  // Comments aside, and the Path's own words for a parsed string's inside ("JSON.parse(data.notes).gift", a text shown).
  const calls = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/`JSON\.parse\(\$\{/g, '');
  for (const f of ['databases/json.ts', ...VIEWS]) expect(calls(f), f).not.toMatch(/JSON\.parse\(/);
  expect(src('databases/json.ts')).toMatch(/^import \{ clipText, looksJsonContainer, maskJson, parseJson, secretKey \} from '\.\/json-text';$/m);
  // pg-json's jsonInString reads through JSON.parse: never used by the view.
  expect(src('databases/json.ts')).not.toContain('jsonInString');
});

test('no global keyboard listener: its keys are its own elements\' (never a terminal\'s or an editor\'s)', () => {
  for (const f of VIEWS) expect(src(f), f).not.toMatch(/addEventListener\('key/);
  // Links open in their browser (main's openUrl), never in the app.
  expect(src('databases/JsonInspector.tsx')).toMatch(/window\.atelier\.openUrl\(/);
  for (const f of VIEWS) expect(src(f), f).not.toMatch(/<a\s|window\.open\(|location\.href/);
  // One definition of the secret keys: json-text.ts's.
  expect(src('databases/json.ts')).toMatch(/^import \{[^}]*\bsecretKey\b[^}]*\} from '\.\/json-text';$/m);
  expect(src('databases/json.ts')).not.toMatch(/MASK_COLUMN/);
});

test('colors only through the theme\'s tokens; no gradient fill, no halo (quiet finish)', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  expect(code).not.toMatch(/gradient\(/);
  expect(code).not.toMatch(/--glow/);
  has('.dbj-cm-bar > i', 'background: var(--violet)');
});

test('its selectors are its own: every one the JSON tools\' (.dbj), none of another stylesheet redefined', () => {
  const mine = selectors(code);
  expect(mine.filter((s) => !s.startsWith('.dbj'))).toEqual([]);
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(mine.filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
});

test('the head and every tree line one line; keys and values ellipsize (whole in their tooltips); the panel is its own container', () => {
  has('.dbj', 'min-width: 0', 'container: dbj / inline-size');
  has('.dbj-head', 'white-space: nowrap', 'overflow: hidden');
  has('.dbj-title', 'min-width: 0');
  has('.dbj-name', 'min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap');
  has('.dbj-meta', 'min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap');
  for (const sel of ['.dbj-views', '.dbj-ib']) has(sel, 'flex: none');
  has('.dbj-row', 'display: flex', 'height: 20px', 'white-space: nowrap', 'overflow: hidden', 'min-width: 0');
  // Keys first: a key keeps its whole text up to 10 characters (its floor, set per line), the value gives
  // way a thousand times faster.
  has('.dbj-k', 'max-width: 60%', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  expect(src('databases/JsonLine.tsx')).toContain('minWidth: `${Math.min(JSON.stringify(r.key).length, 10)}ch`');
  has('.dbj-v', 'flex: 0 1000 auto', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  // A narrow tree steps each level 8 px instead of 14.
  expect(src('databases/JsonLine.tsx')).toContain('var(--dbj-indent, 14px)');
  expect(code).toMatch(/@container dbjt \(max-width: 360px\) \{[^@]*--dbj-indent: 8px/);
  // The hint gives way first.
  has('.dbj-hint', 'flex: 0 1000 auto', 'min-width: 0', 'text-overflow: ellipsis');
  for (const sel of ['.dbj-no', '.dbj-tw', '.dbj-chip', '.dbj-more', '.dbj-p']) has(sel, 'flex: none');
  has('.dbj-chip', 'white-space: nowrap');
  // The tree never scrolls sideways: what is long ellipsizes.
  has('.dbj-tree', 'overflow-x: hidden', 'overflow-y: auto');
  // A fixed line height: the virtualized window's arithmetic (JsonInspector.tsx ROW_H).
  expect(src('databases/JsonInspector.tsx')).toMatch(/^const ROW_H = 20;$/m);
});

test('a line\'s actions take the value\'s tail at the right (its ellipsis), never cover it; shown on hover and on the selected line', () => {
  has('.dbj-acts', 'flex: none', 'display: none', 'margin-left: auto');
  expect(rule('.dbj-acts')).not.toMatch(/position: absolute/);
  has('.dbj-row:hover .dbj-acts', 'display: flex');
  has('.dbj-row.is-sel .dbj-acts', 'display: flex');
  has('.dbj-act', 'flex: none');
});

test('the breadcrumb is cut from its start, the leaf stays: laid out from the right, the steps ordered leaf first', () => {
  has('.dbj-crumbs', 'display: flex', 'flex-direction: row-reverse', 'overflow: hidden', 'white-space: nowrap', 'min-width: 0');
  // A filler at the right takes what a short path leaves: it still starts at the left.
  has('.dbj-crumbs::before', 'order: -1', 'flex: 1 1 0');
  has('.dbj-ci', 'flex: none');
  has('.dbj-ci.is-leaf', 'max-width: 100%');
  has('.dbj-crumb', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  expect(src('databases/JsonInspector.tsx')).toMatch(/style=\{\{ order: n - 1 - i \}\}/);
});

test('the bottom bar: Path and SQL each one line, ellipsized; Copy never shrinks or wraps', () => {
  has('.dbj-bar-row', 'display: flex', 'min-width: 0');
  has('.dbj-bar-l', 'flex: none');
  has('.dbj-bar-code', 'flex: 1 1 0', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  has('.dbj-bar-copy', 'flex: none', 'white-space: nowrap');
});

test('find: the field gives way, the count and the buttons never; Expand all folds to its icon in a narrow panel', () => {
  has('.dbj-find.db-input', 'flex: 1 1 auto');
  for (const sel of ['.dbj-count', '.dbj-expand']) has(sel, 'flex: none', 'white-space: nowrap');
  expect(code).toMatch(/@container dbj \(max-width: \d+px\) \{ \.dbj-expand-l \{ display: none; \}/);
});

test('the Table view scrolls both ways (an array of many keys); its cells one line with an ellipsis', () => {
  has('.dbj-table', 'overflow: auto', 'min-width: 0');
  has('.dbj-tt', 'table-layout: fixed');
  has('.dbj-tt th, .dbj-tt td'.split(', ')[0]!, 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbj-raw-pre', 'overflow: auto', 'white-space: pre', 'user-select: text');
});

test('the column menu: a key\'s path ellipsizes, its kind and presence never; items one line', () => {
  has('.dbj-cm', 'position: absolute', 'z-index: 30');
  has('.dbj-cm-key', 'display: grid', 'minmax(0, 1fr)');
  has('.dbj-cm-path', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  has('.dbj-cm-kind, .dbj-cm-add'.split(', ')[0]!, 'flex: none', 'white-space: nowrap');
  has('.dbj-cm-item', 'white-space: nowrap', 'min-width: 0');
  has('.dbj-cm-label', 'min-width: 0', 'text-overflow: ellipsis');
  has('.dbj-cm-hint', 'flex: none');
  // "+ Column" on hover and on the keyboard's focus, in the kind's place.
  expect(code).toMatch(/\.dbj-cm-key:not\(\[aria-disabled="true"\]\):hover \.dbj-cm-add, \.dbj-cm-key:not\(\[aria-disabled="true"\]\):focus-visible \.dbj-cm-add \{ display: inline; \}/);
});

test('the header\'s menu button (table.css): over the name\'s tail on hover, always on a JSON column — whose name keeps room for it', () => {
  const t = ruleIn(table);
  expect(t('.dbt-th-menu')).toMatch(/position: absolute/);
  expect(t('.dbt-th-menu')).toMatch(/display: none/);
  expect(t('.dbt-th:hover .dbt-th-menu')).toMatch(/display: flex/);
  expect(t('.dbt-th.is-json .dbt-th-menu')).toMatch(/display: flex/);
  expect(t('.dbt-th.is-menu .dbt-th-menu')).toMatch(/display: flex/);
  expect(t('.dbt-th.is-json .dbt-th-btn')).toMatch(/padding-right: \d+px/);
});

test('no module differs from another only by case (`./json` must never find JsonInspector.tsx\'s twin)', () => {
  const names = readdirSync(join(RENDERER, 'databases')).filter((f) => !/\.test\./.test(f) && /\.tsx?$/.test(f)).map((f) => f.replace(/\.tsx?$/, ''));
  const lower = names.map((n) => n.toLowerCase());
  expect(lower.filter((n, i) => lower.indexOf(n) !== i)).toEqual([]);
  expect(names).toContain('json');
  expect(names).not.toContain('Json');
});
