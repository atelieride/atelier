// The row inspector: its stylesheet and code come with the table's lazy chunk,
// never the first paint; colors only through Aurora's tokens; its selectors its own; the layout rules
// that hold at every width, since the FK peek card once collided (name, plan chip and "Open ›"
// overlapping, "Open" wrapping): the label one line with an ellipsis, the chip never wraps and gives way last, "Open ›"
// never shrinks and sits at the right, the lines under it one each; below ~300 px of card the chip moves to the line
// under it. Field rows: name and type line ellipsize, values wrap only inside their area. The e2e layout check measures
// the same on screen.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'inspector.css');
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
/** The declarations of every rule naming `sel` (inside @container blocks too), joined. */
const rule = (sel: string) => [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === sel)).map((m) => m[2]!).join(';');
const has = (sel: string, ...decls: string[]) => {
  for (const d of decls) expect(rule(sel), `${sel} { ${d} }`).toContain(d);
};

test('the stylesheet and the code travel with the table\'s lazy chunk; the first paint reaches neither', () => {
  expect(src('databases/Inspector.tsx')).toMatch(/^import '\.\/inspector\.css';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ Inspector \} from '\.\/Inspector';$/m);
  expect(src('styles.ts')).not.toContain('inspector.css');
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'popout-payload.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx', 'redis/view.ts', 'redis/RedisValue.tsx',
    'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(Inspector|inspector-model|inspector-data|json-text)'/m);
  // The Redis tree is reused, not copied (it reads the lossless trees too).
  expect(src('databases/Inspector.tsx')).toMatch(/^import \{ JsonView \} from '\.\.\/redis\/RedisValue';$/m);
  expect(src('databases/Inspector.tsx')).not.toMatch(/function JsonView|jsonLines\(/);
});

test('no import cycle between the rows and the inspector\'s reads: data.ts announces a new first page, inspector-data.ts listens', () => {
  expect(src('databases/data.ts')).not.toMatch(/from '\.\/inspector-data'/);
  expect(src('databases/inspector-data.ts')).toMatch(/onFirstPage\(/);
});

test('colors only through the theme\'s tokens; no gradient fill, no halo (quiet finish)', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  expect(code).not.toMatch(/gradient\(/);
  expect(code).not.toMatch(/--glow/);
});

test('its selectors are its own: every one the inspector\'s, none of another stylesheet redefined', () => {
  const mine = selectors(code);
  expect(mine.filter((s) => !s.startsWith('.dbi'))).toEqual([]);
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(mine.filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
});

test('the FK peek card at every width: label ellipsizes first, the chip gives way last and never wraps, Open › never shrinks, at the right', () => {
  has('.dbi-peek-head', 'display: flex', 'min-width: 0');
  has('.dbi-peek-label', 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis', 'min-width: 0', 'flex: 0 1000 auto');
  has('.dbi-peek .dbi-peek-chip', 'white-space: nowrap', 'flex: 0 1 auto', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbi-peek-open', 'flex: none', 'white-space: nowrap', 'margin-left: auto');
  has('.dbi-peek-sub', 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbi-peek-subt', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  // The card is its own container: below ~300 px the head's chip hides and the line under it shows its copy.
  has('.dbi-peek', 'container: dbi-peek / inline-size');
  has('.dbi-peek-sub > .dbi-peek-chip', 'display: none');
  expect(code).toMatch(/@container dbi-peek \(max-width: 300px\) \{ \.dbi-peek-head > \.dbi-peek-chip \{ display: none; \} \.dbi-peek-sub > \.dbi-peek-chip \{ display: inline-block; \} \}/);
});

test('field rows: name and type line one line with an ellipsis; values wrap only inside the value area, long unbroken ones break there', () => {
  has('.dbi-fn', 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis', 'min-width: 0');
  has('.dbi-ft', 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis', 'min-width: 0');
  has('.dbi-fv', 'min-width: 0', 'overflow-wrap: anywhere');
  has('.dbi-fv > *', 'max-width: 100%');
  has('.dbi-text', 'white-space: pre-wrap', 'overflow-wrap: anywhere');
  has('.dbi-f', 'display: grid', 'minmax(0, 1fr)');
  // The JSON tree's lines wrap inside the panel too (the Redis tree keeps one line each: pre).
  has('.dbi-json .rd-jl', 'white-space: pre-wrap', 'overflow-wrap: anywhere');
  // The body never scrolls sideways: what is wide breaks instead.
  has('.dbi-body', 'overflow-x: hidden');
  // A narrow panel stacks each name over its value instead of squeezing both.
  expect(code).toMatch(/@container dbi \(max-width: \d+px\) \{ \.dbi-f \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test('over the grid: only the rows\' box — the toolbar, the filter bar, the footer and every popover stay on top', () => {
  has('.dbi.is-over', 'position: absolute', 'right: 0', 'top: 0', 'bottom: 0');
  const z = (css: string, sel: string) => {
    const m = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((x) => x[1]!.split(',').some((s) => s.trim() === sel));
    return Number(/z-index: (\d+)/.exec(m?.[2] ?? '')?.[1] ?? NaN);
  };
  const table = readFileSync(join(RENDERER, 'databases', 'table.css'), 'utf8');
  const filters = readFileSync(join(RENDERER, 'databases', 'filters.css'), 'utf8');
  const over = z(code, '.dbi.is-over');
  expect(over).toBeGreaterThan(z(table, '.dbt-fade'));
  expect(over).toBeLessThan(z(table, '.dbt-pop'));
  expect(over).toBeLessThan(z(filters, '.dbt-fpop'));
  // The rows' box holds it, beside the grid or over it: one place, so a flip never mounts it again.
  expect(table).toMatch(/\.dbt-rows \{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 0;[^}]*display: flex;[^}]*\}/);
  const view = src('databases/TableView.tsx');
  expect(view).toMatch(/<div className="dbt-rows">\s*<Body [^\n]*\/>\s*\{inspector\}\s*<\/div>/);
  expect(view.split('{inspector}').length - 1).toBe(1);
  // The grid's side of the box gives way to the panel (never pushed out of it).
  expect(table).toMatch(/\.dbt-rows > \.dbt-body, \.dbt-rows > \.dbt-center \{[^}]*min-width: 0;/);
});

test('the width kept is the one chosen: the tab\'s width caps what is drawn, never what is kept', () => {
  const insp = src('databases/Inspector.tsx');
  // The app's width, one for every tab (inspector-width.ts), saved for the next start.
  expect(insp).toMatch(/const setWidth = \(w: number\) => setInspectorWidth\(w\);/);
  // The drag draws as far as the cap, and keeps what the pointer chose.
  expect(insp).toMatch(/w = clampWidth\(w0 - \(ev\.clientX - x0\)\);\s*panel\.style\.width = `\$\{Math\.min\(cap, w\)\}px`;/);
});

test('a masked enum chip has a neutral tint', () => {
  has('.dbi-peek .dbi-peek-chip.is-masked', '--c: var(--text-4)');
});

test('the panel: its own container, beside the grid (never shrinking) or over it (a tab too narrow); its head and rows never wrap', () => {
  has('.dbi', 'flex: none', 'min-width: 0', 'container: dbi / inline-size');
  has('.dbi.is-over', 'position: absolute', 'right: 0', 'top: 0', 'bottom: 0');
  has('.dbi-head', 'white-space: nowrap', 'overflow: hidden');
  has('.dbi-key', 'min-width: 0', 'text-overflow: ellipsis');
  for (const sel of ['.dbi-views', '.dbi-ib']) has(sel, 'flex: none');
  has('.dbi-ref', 'white-space: nowrap');
  has('.dbi-ref-t', 'min-width: 0', 'text-overflow: ellipsis');
  has('.dbi-ref-n', 'flex: none');
  has('.dbi-more-names', 'min-width: 0', 'text-overflow: ellipsis');
});
