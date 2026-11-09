// The database overview tab: its stylesheet and strings come with the table
// tab's lazy chunk (DbTabView), never the first paint (the live demo's budget); colors only through
// Aurora's tokens, flat (the quiet finish); production's 2 px hairline is the tab's own (databases.css), never painted
// over; and the layout rules that hold at every width: values and names ellipsize, numbers and chips never wrap, the
// header's chips wrap as a group, Now running scrolls sideways inside its card.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'overview.css');
const code = readFileSync(OWN, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const src = (f: string) => readFileSync(join(RENDERER, f), 'utf8');

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));
}
function selectors(text: string): string[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...t.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim()).filter((s) => s && !s.startsWith('@'))
    .flatMap((s) => s.split(',')).map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
/** The declarations of every rule naming `sel`, joined. */
const rule = (sel: string) => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');

test('the stylesheet and the strings travel with the overview, behind DbTabView\'s lazy boundary', () => {
  expect(src('databases/OverviewView.tsx')).toMatch(/^import '\.\/overview\.css';$/m);
  expect(src('databases/OverviewView.tsx')).toMatch(/^import \{ tov \} from '\.\.\/i18n\/db-overview';$/m);
  expect(src('databases/DbTabView.tsx')).toMatch(/^import \{ OverviewView \} from '\.\/OverviewView';$/m);
  expect(src('styles.ts')).not.toContain('overview.css');
  expect(src('App.tsx')).toMatch(/const DbTabView = lazy\(\(\) => import\('\.\/databases\/DbTabView'\)/);
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx', 'databases/install.ts', 'databases/store.ts',
    'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) {
    const s = src(f);
    expect(s, f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(OverviewView|overview)'/m);
    expect(s, f).not.toMatch(/^import [^;]*from '[./]*i18n\/db-overview'/m);
  }
});

test('colors only through the theme\'s tokens: no hex, rgb or hsl value of its own', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
});

test('redefines no selector of another stylesheet; its own all start with .dbo', () => {
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(selectors(code).filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
  expect(selectors(code).filter((s) => !/^\.dbo\b/.test(s))).toEqual([]);
});

test('production: the glyph in the danger color; nothing paints over the tab\'s 2 px hairline', () => {
  expect(rule('.dbo.is-prod .dbo-glyph')).toMatch(/color: var\(--text-error\)/);
  expect(rule('.dbo.is-prod .dbo-glyph')).toMatch(/var\(--edge-error\)/);
  expect(rule('.dbo')).not.toMatch(/background/);
  expect(rule('.dbo')).toMatch(/padding: \d+px/);
  // The view scrolls as a whole: its content clips under a transparent 2 px border, so cards scrolled up never cover it.
  expect(rule('.dbo')).toMatch(/overflow-y: auto/);
  expect(rule('.dbo')).toMatch(/border-top: 2px solid transparent/);
});

test('the tiles: a grid of --dbo-cols columns that never overflow; the longest query amber over 30 s', () => {
  expect(rule('.dbo-tiles')).toMatch(/display: grid/);
  expect(rule('.dbo-tiles')).toMatch(/grid-template-columns: repeat\(var\(--dbo-cols\), minmax\(0, 1fr\)\)/);
  expect(rule('.dbo-tile')).toMatch(/min-width: 0/);
  expect(rule('.dbo-tile.is-long')).toMatch(/var\(--edge-waiting\)/);
  expect(rule('.dbo-tile.is-long .section-label')).toMatch(/color: var\(--waiting\)/);
});

test('names, values and lines truncate with an ellipsis instead of pushing their box wider', () => {
  for (const sel of ['.dbo-name', '.dbo-sub', '.dbo-v', '.dbo-s', '.dbo-bar-name', '.dbo-q-text', '.dbo-role > span', '.dbo-kv-name', '.dbo-kv-val', '.dbo-paused > span']) {
    const r = rule(sel);
    expect(r, sel).toMatch(/min-width: 0/);
    expect(r, sel).toMatch(/overflow: hidden/);
    expect(r, sel).toMatch(/text-overflow: ellipsis/);
    expect(r, sel).toMatch(/white-space: nowrap/);
  }
  // Their flex and grid parents let them shrink.
  for (const sel of ['.dbo-head', '.dbo-title', '.dbo-name-row', '.dbo-bar', '.dbo-q-line', '.dbo-paused', '.dbo-card']) expect(rule(sel), sel).toMatch(/min-width: 0/);
});

test('numbers and chips keep their size and never wrap; the header\'s chips wrap as a group', () => {
  for (const sel of ['.dbo-bar-size', '.dbo-role', '.dbo-mask', '.dbo-provider', '.dbo-st', '.dbo-ask', '.dbo-glyph', '.dbo-count', '.dbo-paused > button']) {
    expect(rule(sel), sel).toMatch(/flex: none/);
  }
  for (const sel of ['.dbo-bar-size', '.dbo-role', '.dbo-mask', '.dbo-provider', '.dbo-st', '.dbo-ask', '.dbo-count', '.dbo-paused > button']) {
    expect(rule(sel), sel).toMatch(/white-space: nowrap/);
  }
  expect(rule('.dbo-bar-size')).toMatch(/text-align: right/);
  expect(rule('.dbo-bar-size')).toMatch(/font-variant-numeric: tabular-nums/);
  expect(rule('.dbo-chips')).toMatch(/flex-wrap: wrap/);
  // A chip wider than the pane ellipsizes its label instead of spilling out.
  expect(rule('.dbo-role')).toMatch(/max-width: 100%/);
  // Stacked: the chips go under the name (grid areas), not off the edge.
  expect(rule('.dbo-head.is-stacked')).toMatch(/grid-template-areas/);
});

test('Now running scrolls sideways inside its card; its query is one line', () => {
  expect(rule('.dbo-scroll')).toMatch(/overflow-x: auto/);
  expect(rule('.dbo-act')).toMatch(/table-layout: fixed/);
  expect(rule('.dbo-act')).toMatch(/min-width: \d+px/);
  expect(rule('.dbo-act td')).toMatch(/white-space: nowrap/);
  expect(rule('.dbo-act td')).toMatch(/overflow: hidden/);
  expect(rule('.dbo-act td')).toMatch(/text-overflow: ellipsis/);
  expect(rule('.dbo-act tr.is-long')).toMatch(/background: var\(--tint-waiting\)/);
  expect(rule('.dbo-act tr.is-long .dbo-for')).toMatch(/color: var\(--waiting\)/);
});

test('flat: the bars and the state chips are solid fills, the line a stroke (the quiet finish)', () => {
  expect(rule('.dbo-bar-track > i')).toMatch(/background: var\(--brand\)/);
  expect(code).not.toMatch(/gradient\(/);
  expect(rule('.dbo-spark polyline')).toMatch(/stroke: var\(--[\w-]+\)/);
  for (const t of ['sky', 'amber', 'grey', 'ours']) expect(rule(`.dbo-st.is-${t}`), t).toMatch(/background: var\(--[\w-]+\)/);
});

test('everything it does answers hover and keyboard focus', () => {
  for (const sel of ['.dbo-bar', '.dbo-mask', '.dbo-ask']) {
    expect(rule(`${sel}:hover`), sel).toMatch(/background|color/);
    expect(rule(`${sel}:focus-visible`), sel).toMatch(/box-shadow: [^;]*var\(--violet\)/);
  }
  // Now running's rows take the keyboard (one in the Tab order, the arrows between them): the focused one is ringed
  // inside its edges (an outline: a table row draws no box-shadow).
  expect(rule('.dbo-act tbody tr:focus-visible')).toMatch(/outline: 1\.5px solid var\(--violet\)/);
  expect(rule('.dbo-act tbody tr:focus-visible')).toMatch(/outline-offset: -1\.5px/);
});
