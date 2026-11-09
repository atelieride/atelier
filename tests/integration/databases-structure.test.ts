// Structure and Relations: their stylesheet and code come with the
// table's lazy chunk, never the first paint; colors only through Aurora's tokens, a quiet finish;
// their selectors their own; the layout rules that hold at every width — tables scroll sideways inside their section,
// names ellipsize, badges, buttons and the 1:N mark never shrink or wrap, the code views scroll, the cards stack below
// ~720 px; no listener outside their own elements; Refresh reads the visible view again; and the sizes main reads for
// them take no lock. The e2e layout check measures the same on screen.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const RENDERER = join(ROOT, 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'structure.css');
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
const has = (sel: string, ...decls: string[]) => {
  for (const d of decls) expect(rule(sel), `${sel} { ${d} }`).toContain(d);
};

test('the stylesheet and the code travel with the table\'s lazy chunk; the first paint reaches neither', () => {
  expect(src('databases/StructureView.tsx')).toMatch(/^import '\.\/structure\.css';$/m);
  expect(src('databases/RelationsView.tsx')).toMatch(/^import '\.\/structure\.css';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ StructureView \} from '\.\/StructureView';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ RelationsView \} from '\.\/RelationsView';$/m);
  expect(src('styles.ts')).not.toContain('structure.css');
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'popout-payload.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx',
    'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(StructureView|RelationsView|structure-data|structure-model|structure-ui|relations)'/m);
});

test('TableView hands Structure and Relations to the data module\'s steps (tested there: refreshFor, wireStructure); the e2e drive them', () => {
  const view = src('databases/TableView.tsx');
  // Refresh: Structure / Relations first, the rows otherwise.
  const refresh = /const refresh = \(\) => \{([\s\S]*?)\n {2}\};/.exec(view)?.[1] ?? '';
  expect(refresh).toMatch(/if \(refreshFor\(/);
  expect(refresh).toMatch(/void loadFirst\(tab\.key\);/);
  // Its effect: one step with every input it decides by.
  expect(view).toMatch(/wireStructure\(tab\.key, /);
  // ⌘R through refreshKeyAction (a held key's repeats read nothing).
  expect(view).toMatch(/refreshKeyAction\(e\)/);
});

test('both views share one module for their common pieces: the table link and a part\'s failure', () => {
  for (const f of ['databases/StructureView.tsx', 'databases/RelationsView.tsx']) {
    expect(src(f), f).toMatch(/from '\.\/structure-ui';$/m);
    expect(src(f), f).not.toMatch(/export function (tableLink|PartFailed)\b/);
  }
  expect(src('databases/structure-ui.tsx')).toMatch(/export function tableLink\b/);
  expect(src('databases/structure-ui.tsx')).toMatch(/export function PartFailed\b/);
});

test('no listener outside their own elements: nodes, links and the code view are buttons and focusable boxes', () => {
  for (const f of ['databases/StructureView.tsx', 'databases/RelationsView.tsx', 'databases/structure-ui.tsx', 'databases/structure-data.ts']) {
    expect(src(f), f).not.toMatch(/(window|document)\.addEventListener/);
  }
});

test('colors only through the theme\'s tokens; no gradient fill, no halo (quiet finish)', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  expect(code).not.toMatch(/gradient\(/);
  expect(code).not.toMatch(/--glow/);
});

test('its selectors are its own: Structure\'s and the diagram\'s, none of another stylesheet redefined', () => {
  const mine = selectors(code);
  expect(mine.filter((s) => !/^(\[data-motion="reduced"\] )?(button)?\.db[sr]\b/.test(s))).toEqual([]);
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(mine.filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
});

test('tables at every width: they scroll sideways inside their section, fixed columns, names ellipsize, badges never shrink or wrap', () => {
  has('.dbs-x', 'overflow-x: auto', 'min-width: 0');
  has('.dbs-table', 'table-layout: fixed', 'width: 100%');
  has('.dbs-table.is-cols', 'min-width: 600px');
  has('.dbs-table td', 'white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbs-cell', 'display: flex', 'min-width: 0');
  has('.dbs-name', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap');
  has('.dbs-badge', 'flex: none', 'white-space: nowrap');
  has('.dbs-fk', 'min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap');
  has('.dbs-scans.is-never', 'color: var(--waiting)');
  // Hover and focus states: never flat.
  has('.dbs-table tbody tr:hover td', 'background: var(--bg-hover)');
  has('.dbs-fk:focus-visible', 'box-shadow: 0 0 0 1.5px var(--violet)');
});

test('the cards: one column below ~720 px (StructureView\'s structureLayout), the side column never squeezed; code scrolls both ways, Copy never wraps', () => {
  has('.dbs-grid', 'display: flex', 'min-width: 0');
  has('.dbs-grid.is-stacked', 'flex-direction: column', 'align-items: stretch');
  has('.dbs-main', 'flex: 1', 'min-width: 0');
  has('.dbs-side', 'flex: none', 'min-width: 0');
  expect(src('databases/StructureView.tsx')).toMatch(/className=\{`dbs-grid\$\{layout\.stacked \? ' is-stacked' : ''\}`\}/);
  has('.dbs-code', 'overflow: auto', 'white-space: pre', 'max-height: 320px');
  has('.dbs-copy', 'flex: none', 'white-space: nowrap');
  has('.dbs-sec-head > button', 'flex: none', 'white-space: nowrap');
  has('.dbs-leg', 'flex: none', 'white-space: nowrap');
  has('.dbs-legend', 'flex-wrap: wrap');
  has('.dbs-facts > dd', 'min-width: 0', 'text-overflow: ellipsis');
  has('.dbs-err-t', 'min-width: 0', 'text-overflow: ellipsis');
  has('.dbs-err > button', 'flex: none', 'white-space: nowrap');
  // The head: the kind and "owner" never shrink; a long owner name and the comment ellipsize (the comment gives way first).
  // (`pre`: never wraps, and keeps the spaces at the pieces' ends, which a flex item would drop.)
  has('.dbs-head-kind', 'flex: none', 'white-space: pre');
  has('.dbs-head-owner', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis', 'flex: 0 1 auto', 'white-space: pre');
  has('.dbs-head-comment', 'min-width: 0', 'text-overflow: ellipsis', 'flex: 0 1000 auto', 'white-space: pre');
  // "No primary key" in amber; "No indexes" quiet.
  has('.dbs-empty', 'color: var(--text-4)');
  has('.dbs-empty.is-warn', 'color: var(--waiting)');
});

test('the diagram: edges behind, nodes over them; labels ellipsize inside nodes, the 1:N mark never shrinks; the card scrolls past its height', () => {
  has('.dbr-edges', 'position: absolute', 'inset: 0');
  has('.dbr-node', 'position: absolute', 'min-width: 0', 'white-space: nowrap');
  has('.dbr-node-name', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbr-node-via', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbr-node-n', 'flex: none');
  has('.dbr-box', 'overflow: auto', 'max-height: 360px', 'min-width: 0');
  has('button.dbr-node:hover', 'background: var(--bg-hover)');
  has('button.dbr-node:focus-visible', 'box-shadow:');
  // This table: the selection's flat tint (quiet finish), not a gradient.
  has('.dbr-node.is-center', 'background: var(--bg-sel)');
});

test('the first read breathes a finite number of times (the idle motion budget), and not at all with Reduce motion', () => {
  expect(rule('.dbs-skel > span')).toMatch(/animation: atl-breathe [^;]*var\(--cue-cycles-long\)/);
  expect(code).not.toMatch(/\binfinite\b/);
  expect(code).toContain('[data-motion="reduced"] .dbs-skel > span { animation: none; }');
});

test('main measures Structure\'s sizes without a lock: no pg_*_size of a relation in the catalog reader\'s statements', () => {
  const catalog = readFileSync(join(ROOT, 'src/main/databases/postgres/catalog.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(catalog.match(/pg_(relation|table|indexes|total_relation)_size/g) ?? []).toEqual([]);
  expect(catalog).toMatch(/relpages/);
});
