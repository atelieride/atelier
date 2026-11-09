// The record view: its stylesheet and code come with the table's lazy chunk,
// never the first paint; colors only through Aurora's tokens; its selectors its own; the layout that
// holds at every width — names and type lines one line with an ellipsis (their tooltips whole), values wrap inside their
// area and long unbroken ones break there, a narrow pane stacks each name over its value; its keys heard on its own
// element (no window or document listener: nothing taken from terminals, editors or fields). The e2e layout check
// (databases-layout.spec.ts) measures the same on screen.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer');
const OWN = join(RENDERER, 'databases', 'record.css');
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
  expect(src('databases/RecordView.tsx')).toMatch(/^import '\.\/record\.css';$/m);
  expect(src('databases/TableView.tsx')).toMatch(/^import \{ RecordView \} from '\.\/RecordView';$/m);
  expect(src('styles.ts')).not.toContain('record.css');
  const firstPaint = ['App.tsx', 'store.ts', 'styles.ts', 'popout-payload.ts', 'components/Tabs.tsx', 'components/PopoutWindow.tsx', 'shortcuts.ts',
    'databases/install.ts', 'databases/store.ts', 'databases/view.ts', 'databases/tabs.ts'];
  for (const f of firstPaint) expect(src(f), f).not.toMatch(/^import [^;]*from '[./]*(databases\/)?(RecordView|record)'/m);
  // The inspector's field rows are reused, not copied (one rendering of a value, its masks, its JSON tree, its card).
  expect(src('databases/RecordView.tsx')).toMatch(/^import \{ [^}]*\bFieldRow\b[^}]*\buseRowData\b[^}]*\} from '\.\/Inspector';$/m);
  expect(src('databases/RecordView.tsx')).not.toMatch(/function (FieldRow|PeekCard|Value|JsonField)\b|<JsonView\b/);
});

test('its keys are its own element\'s: no window or document listener (nothing taken from a terminal, an editor or a field)', () => {
  for (const f of ['databases/RecordView.tsx', 'databases/record.ts']) {
    expect(src(f), f).not.toMatch(/(document|window)\.addEventListener\(/);
  }
  expect(src('databases/RecordView.tsx')).toMatch(/onKeyDown=\{onKeyDown\}/);
});

test('colors only through the theme\'s tokens; no gradient fill, no halo (quiet finish)', () => {
  expect(code.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).toEqual([]);
  expect(code).not.toMatch(/gradient\(/);
  expect(code).not.toMatch(/--glow/);
});

test('its selectors are its own: every one the record view\'s, none of another stylesheet redefined', () => {
  const mine = selectors(code);
  expect(mine.length).toBeGreaterThan(5);
  expect(mine.filter((s) => !s.startsWith('.dbrv'))).toEqual([]);
  const others = new Map<string, string>();
  for (const f of cssFiles(RENDERER)) if (f !== OWN) for (const s of selectors(readFileSync(f, 'utf8'))) others.set(s, relative(RENDERER, f));
  expect(mine.filter((s) => others.has(s)).map((s) => `${s} (${others.get(s)})`)).toEqual([]);
});

test('every width: the head one line (its position and key ellipsize, its buttons never shrink); the body scrolls down, never sideways', () => {
  has('.dbrv', 'min-width: 0', 'min-height: 0', 'container: dbrv / inline-size');
  has('.dbrv-head', 'white-space: nowrap', 'overflow: hidden', 'min-width: 0');
  has('.dbrv-pos', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbrv-key', 'min-width: 0', 'overflow: hidden', 'text-overflow: ellipsis');
  has('.dbrv-ib', 'flex: none');
  has('.dbrv-body', 'overflow-x: hidden', 'overflow-y: auto', 'min-height: 0', 'user-select: text');
});

test('a field: name and type line on the left (the inspector\'s ellipsis rules), the value on the right, whole and wrapping; narrow, stacked', () => {
  // Wide: two columns, the names' bounded, the values' taking the rest (never squeezed to nothing).
  has('.dbrv-body .dbi-f', 'grid-template-columns: minmax(0, clamp(', 'minmax(0, 1fr)');
  has('.dbrv-body .dbi-f.is-wide > .dbi-fv', 'grid-column: 2');
  has('.dbrv-body .dbi-f > .dbi-peek', 'grid-column: 2');
  // Narrow: each name over its value, the card under them.
  expect(code).toMatch(/@container dbrv \(max-width: \d+px\) \{[^@]*\.dbrv-body \.dbi-f \{ grid-template-columns: minmax\(0, 1fr\);/);
});
