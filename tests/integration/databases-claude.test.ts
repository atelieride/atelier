// The Databases view's Claude hand-off: the action bar's stylesheet and
// the prompts and actions come with the view's lazy chunks, never the first paint, which only gains
// the session helpers' export entries; colors only through Aurora's tokens; the bar's layout at every width (labels
// fold to icons, never wrap, never hide the last row or the footer); ⌥↩ listed in Settings › Keyboard; nothing filtered
// (no redactSecrets) and no value through JSON.parse; no listener outside its own elements.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { SHORTCUTS, keysOf } from '../../src/renderer/shortcuts';
import { MENU_SPEC, menuItems } from '../../src/shared/menu-spec';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'selbar.css');
const css = readFileSync(OWN, 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f: string) => readFileSync(join(RENDERER, f), 'utf8');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}
function selectors(text: string): string[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...t.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
/** The declarations of every rule naming `sel` in `text` (inside @container blocks too), joined. */
const ruleIn = (text: string) => (sel: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');
const rule = ruleIn(css);
/** The rules inside `@container dbsel (max-width: Npx)` blocks, by their width. */
function containerRules(): { width: number; body: string }[] {
  const out: { width: number; body: string }[] = [];
  const re = /@container dbsel \(max-width: (\d+)px\) \{/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0;
    out.push({ width: Number(m[1]), body: code.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}
const px = (decls: string, prop: string) => Number(new RegExp(`(?:^|;)\\s*${prop}: (\\d+)px`).exec(decls)?.[1] ?? NaN);

test('the bar\'s stylesheet, the prompts and the actions travel with the table\'s lazy chunk; the first paint reaches none', () => {
  expect(src('databases/SelBar.tsx')).toMatch(/^import '\.\/selbar\.css';$/m);
  expect(src('databases/Grid.tsx')).toMatch(/^import \{ [^}]*\bSelBar\b[^}]* \} from '\.\/SelBar';$/m);
  expect(src('styles.ts')).not.toContain('selbar.css');
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'popout-payload.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx', 'components/Settings.tsx',
    'shortcuts.ts', 'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(actions|prompts|SelBar)'/m);
  // The sidebar's menu imports them statically: they share the chunk the sidebar and the table tab both load. A dynamic
  // import there would put a chunk name in the entry's preload map and export Vite's preload helper from it (the
  // first-paint measure): the first paint only gains the three session helpers' export entries.
  const menus = src('databases/menus.ts');
  expect(menus).toMatch(/^import \{ askTable, sendSchema \} from '\.\/actions';$/m);
  expect(menus).not.toMatch(/import\('/);
  // The session helpers are the Docker and Redis views' own (one "ask in a new session" for the three views).
  expect(src('databases/actions.ts')).toMatch(/^import \{ askInSession, sendTarget, sendToSession \} from '\.\.\/docker\/actions';$/m);
  expect(src('redis/actions.ts')).toMatch(/askInSession\(t\.redis\.sessionName\(name\), prompt, t\.redis\.typed\(name\)\)/);
  for (const f of ['databases/actions.ts', 'redis/actions.ts']) expect(src(f), f).not.toMatch(/newSessionIn|typeWhenReadyAs/);
});

test('colors only through the theme\'s tokens; its selectors its own (.db-sel…, .db-split…)', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(selectors(css).filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
  expect(selectors(css).filter((s) => !/^\.db-(sel|split)/.test(s))).toEqual([]);
});

test('the bar floats over the grid\'s foot: the pointer goes through around it, popovers stay above it, a fade below', () => {
  const wrap = rule('.db-selwrap');
  expect(wrap).toMatch(/position: absolute/);
  expect(wrap).toMatch(/left: 0/);
  expect(wrap).toMatch(/pointer-events: none/);
  expect(wrap).toMatch(/container: dbsel \/ inline-size/);
  const z = Number(/z-index: (\d+)/.exec(wrap)?.[1]);
  // Over the grid's right fade (5), under the inspector lying over the rows (6: the bar is moved left of it) and every
  // popover (30).
  expect(z).toBeGreaterThanOrEqual(5);
  expect(z).toBeLessThan(30);
  expect(rule('.db-selbar')).toMatch(/pointer-events: auto/);
  expect(rule('.db-selbar')).toMatch(/background: var\(--bg-float\)/);
  expect(rule('.db-selbar')).toMatch(/box-shadow: var\(--shadow-float\)/);
});

test('one line at every width: buttons never shrink, Send\'s session name ellipsizes, nothing wraps', () => {
  const bar = rule('.db-selbar');
  expect(bar).toMatch(/white-space: nowrap/);
  expect(bar).toMatch(/min-width: 0/);
  expect(bar).toMatch(/max-width: 100%/);
  expect(bar).not.toMatch(/flex-wrap: wrap/);
  expect(rule('.db-selbar > button')).toMatch(/flex: none/);
  expect(rule('.db-selbar > .db-split')).toMatch(/flex: none/);
  expect(rule('.db-selbar > .sel-send')).toMatch(/flex: 0 1 auto/);
  expect(rule('.db-selbar > .sel-send')).toMatch(/min-width: 0/);
  expect(rule('.db-selbar-n')).toMatch(/flex: none/);
  expect(src('databases/SelBar.tsx')).toMatch(/<span className="dk-ellipsis db-sel-label">/);
});

test('a narrower grid folds the labels to icons (names in the tooltips), then the count; too narrow for its buttons, no bar', () => {
  const rules = containerRules();
  const at = (sel: string) => rules.filter((r) => r.body.includes(sel) && /display: none/.test(r.body)).map((r) => r.width);
  const labels = Math.max(...at('.db-sel-label'));
  const count = Math.max(...at('.db-selbar-n'));
  const none = Math.max(...rules.filter((r) => /\.db-selbar \{ display: none; \}/.test(r.body)).map((r) => r.width));
  expect(at('.kbd-in')).toContain(labels);
  expect(labels).toBeGreaterThan(count);
  expect(count).toBeGreaterThan(none);
  // With the labels gone, Send keeps an icon of its own (its name in its aria-label and tooltip).
  expect(rules.find((r) => r.width === count)?.body ?? '').toMatch(/\.db-sel-icon \{ display: inline-flex; \}/);
  expect(rule('.db-sel-icon')).toMatch(/display: none/);
  // The icons' bar fits in the narrowest grid that still shows it: five 28 px buttons, the gaps and the padding.
  expect(none).toBeGreaterThanOrEqual(5 * 28 + 4 * 6 + 12);
  const sel = src('databases/SelBar.tsx');
  for (const label of ['askNew', 'copyJson', 'formats', 'clear']) expect(sel, label).toMatch(new RegExp(`aria-label=\\{c\\.${label}\\} data-tip=\\{c\\.\\w+\\}`));
});

test('the bar never hides a row or the footer: the rows always end with its room, a row brought into view stops above it', () => {
  const wrap = rule('.db-selwrap');
  const bar = rule('.db-selbar');
  // The room is one constant (grid-model's BAR_ROOM, read as text: grid-model reaches JSX, which this project's tsconfig
  // doesn't compile): the bar's buttons (28 px), its padding, the wrapper's bottom padding.
  const BAR_ROOM = Number(/^export const BAR_ROOM = (\d+);$/m.exec(src('databases/grid-model.ts'))?.[1]);
  expect(BAR_ROOM).toBeGreaterThanOrEqual(28 + 2 * px(bar, 'padding') + px(wrap, 'padding-bottom'));
  const grid = src('databases/Grid.tsx');
  // Always there (clearing the selection never shifts the rows), as tall as the constant says.
  expect(grid).toMatch(/<div className="dbt-barroom" aria-hidden="true" style=\{\{ height: BAR_ROOM \}\} \/>/);
  expect(grid).not.toMatch(/bar && <div className="dbt-barroom"/);
  expect(readFileSync(join(RENDERER, 'databases', 'table.css'), 'utf8')).not.toMatch(/\.dbt-barroom \{[^}]*height/);
  // ↓/↑, Shift+F10 and a row picked from outside bring rows into view above the bar's room.
  expect(grid).toMatch(/revealTop\(row, live\.current\.rowH, el\.scrollTop, el\.clientHeight, BAR_ROOM\)/);
  expect(grid).not.toMatch(/HEAD_H \+ \(row \+ 1\) \* h > el\.scrollTop \+ el\.clientHeight/);
  // In the grid's box (above the footer, which is the tab's own row below it), clear of both its scrollbars.
  expect(grid).toMatch(/right=\{inset \+ gutter\.r\} bottom=\{gutter\.b\}/);
});

test('the Structure view\'s Send Schema: the session\'s name ellipsizes, Copy never shrinks (structure.css)', () => {
  const structure = ruleIn(readFileSync(join(RENDERER, 'databases', 'structure.css'), 'utf8'));
  expect(structure('.dbs-sec-head > .dbs-send')).toMatch(/flex: 0 1 auto/);
  expect(structure('.dbs-sec-head > .dbs-send')).toMatch(/min-width: 0/);
  expect(structure('.dbs-copy')).toMatch(/flex: none/);
  expect(src('databases/StructureView.tsx')).toMatch(/<span className="dk-ellipsis">\{sendSchema\.label/);
});

test('the wiring: the grid\'s menu, ⌥↩ and bar, Structure\'s DDL card, the overview\'s ✦ Ask Claude', () => {
  const grid = src('databases/Grid.tsx');
  expect(grid).toMatch(/sendTo: \{ label: target, run: \(\) => sendRows\(table, src\(\), sel, live\.current\.o\) \}/);
  expect(grid).toMatch(/askNew: \(\) => void askRows\(table, src\(\), sel, live\.current\.o, tabKey\)/);
  expect(grid).toMatch(/act\.kind === 'send'\) \{[^}]*sendRows\(table, src\(\), act\.rows, live\.current\.o\)/);
  // ⌃⌥↩ is not ⌥↩ (as RedisView's): the grid hands gridKey the Control key apart from ⌘.
  expect(grid).toMatch(/alt: e\.altKey, ctrl: e\.ctrlKey,/);
  expect(src('databases/TableView.tsx')).toMatch(/<StructureView [^\n]*\n\s*sendSchema=\{\{ label: target, run: \(\) => void sendSchema\(\{ connId: tab\.connId, schema: tab\.schema, name: tab\.name \}, tab\.key\) \}\}/);
  expect(src('databases/DbTabView.tsx')).toMatch(/<OverviewView [^>]*actions=\{overviewActions\(tab\.connId\)\}/);
});

test('nothing filtered: no redactSecrets; rows as Copy as JSON writes them, never through JSON.parse', () => {
  for (const f of ['databases/actions.ts', 'databases/prompts.ts', 'databases/SelBar.tsx']) {
    const s = noComments(src(f));
    expect(s, f).not.toMatch(/redactSecrets/);
    expect(s, f).not.toMatch(/JSON\.parse|JSON\.stringify|parseFloat|Number\(/);
  }
  expect(src('databases/prompts.ts')).toMatch(/from '\.\/grid-copy'/);
});

test('no listener outside its own elements (the keyboard is the grid\'s own ⌥↩)', () => {
  for (const f of ['databases/actions.ts', 'databases/prompts.ts', 'databases/SelBar.tsx']) {
    expect(noComments(src(f)), f).not.toMatch(/(window|document)\.addEventListener/);
  }
});

test('⌥↩ is listed in Settings › Keyboard\'s Databases group; no menu item takes it', () => {
  const db = SHORTCUTS.find((g) => g.title === 'Databases')!.items;
  const row = db.find((i) => i.keys === '⌥↩');
  expect(row?.label).toMatch(/send/i);
  expect(row?.label).toMatch(/session/i);
  const accels = menuItems(MENU_SPEC).flatMap((i) => ('accelerator' in i && i.accelerator ? [i.accelerator] : []));
  expect(accels.map(keysOf)).not.toContain('⌥↩');
});
