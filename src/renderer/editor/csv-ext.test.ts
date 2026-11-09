import { expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { csvDecorations, csvEditorExtensions, cursorCell, fieldStart, rescanCsv, setCsvConf, unquoteField, type CsvConf } from './csv-ext';

const CONF: CsvConf = { delimiter: ';', skip: 0, header: true, rainbow: true, align: false, widths: [], problemLines: [] };

function state(doc: string, conf: Partial<CsvConf> = {}, head = 0) {
  const s = EditorState.create({ doc, extensions: csvEditorExtensions(), selection: { anchor: head } });
  return s.update({ effects: setCsvConf.of({ ...CONF, ...conf }) }).state;
}

/** The decorations as [from, to, class or widget width] in document order. */
function decos(s: EditorState) {
  const out: [number, number, string][] = [];
  csvDecorations(s, [{ from: 0, to: s.doc.length }]).between(0, s.doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; attributes?: { class?: string }; widget?: { width: number } };
    out.push([from, to, spec.class ?? spec.attributes?.class ?? `pad:${spec.widget?.width}`]);
  });
  return out;
}

const DOC = 'id;name;total\nA-1;Rossi;284,50\nA-2;"Hafen; Co";98,60\n';

test('the cell under the cursor: data row, column, field count and the field\'s offsets', () => {
  const at = (pos: number) => cursorCell(state(DOC, {}, pos));
  const line2 = DOC.indexOf('A-1');
  expect(at(line2 + 5)).toEqual({ row: 0, col: 1, of: 3, line: 2, from: line2 + 4, to: line2 + 9 });
  // A delimiter belongs to the field before it; the header row is row -1.
  expect(at(DOC.indexOf(';name'))).toMatchObject({ row: -1, col: 0 });
  // The delimiter inside quotes is part of the field.
  const q = DOC.indexOf('"Hafen');
  expect(at(q + 8)).toMatchObject({ row: 1, col: 1, from: q, to: q + 11 });
  expect(at(DOC.length)).toBeNull();
  // Without a header the first line is row 0; skipped lines have no cell.
  expect(cursorCell(state(DOC, { header: false }, line2))).toMatchObject({ row: 1 });
  expect(cursorCell(state(DOC, { skip: 1 }, 1))).toBeNull();
});

test('a quoted field spanning lines: its second line belongs to the record that opened it', () => {
  const doc = 'a,b\n1,"two\nlines"\n3,x\n';
  const s = state(doc, { delimiter: ',' }, doc.indexOf('lines'));
  expect(cursorCell(s)).toMatchObject({ row: 0, col: 1, line: 2 });
  expect(cursorCell(state(doc, { delimiter: ',' }, doc.indexOf('3,x')))).toMatchObject({ row: 1, col: 0, line: 4 });
});

test('a cell\'s start offset (the table selecting a cell moves the cursor there)', () => {
  const s = state(DOC);
  expect(fieldStart(s, 0, 2)).toBe(DOC.indexOf('284,50'));
  expect(fieldStart(s, 1, 1)).toBe(DOC.indexOf('"Hafen'));
  expect(fieldStart(s, -1, 1)).toBe(DOC.indexOf('name'));
  // A missing field: the record's end.
  expect(fieldStart(s, 0, 7)).toBe(DOC.indexOf('\nA-2'));
  expect(fieldStart(s, 9, 0)).toBeNull();
});

test('a large file just shortened, its scan not redone yet: a row past the end has no start (never a RangeError)', () => {
  const rows = Array.from({ length: 40_000 }, (_, i) => `R-${i};name ${i};${i},50`);
  const big = state(`id;name;total\n${rows.join('\n')}\n`);
  const cut = big.doc.line(20_000).from;
  const s = big.update({ changes: { from: cut, to: big.doc.length } }).state;
  expect(() => fieldStart(s, 39_000, 1)).not.toThrow();
  expect(fieldStart(s, 39_000, 1)).toBeNull();
});

test('rainbow columns: a class per column, dim delimiters, the header line, problem lines', () => {
  const d = decos(state(DOC, { problemLines: [3] }));
  expect(d).toContainEqual([0, 0, 'cm-csv-head']);
  expect(d).toContainEqual([0, 2, 'cm-csv-c0']);
  expect(d).toContainEqual([2, 3, 'cm-csv-del']);
  expect(d).toContainEqual([3, 7, 'cm-csv-c1']);
  const q = DOC.indexOf('"Hafen');
  expect(d).toContainEqual([q, q + 11, 'cm-csv-c1']);
  expect(d).toContainEqual([DOC.indexOf('A-2'), DOC.indexOf('A-2'), 'cm-csv-bad']);
  // Off: no colors, the problem lines stay.
  const off = decos(state(DOC, { rainbow: false, problemLines: [3] }));
  expect(off.filter(([, , c]) => c.startsWith('cm-csv-c'))).toEqual([]);
  expect(off).toContainEqual([DOC.indexOf('A-2'), DOC.indexOf('A-2'), 'cm-csv-bad']);
});

test('align columns: a spacer after each field but the last, up to its column\'s width', () => {
  const d = decos(state(DOC, { align: true, widths: [4, 11, 6] }));
  const pads = d.filter(([, , c]) => c.startsWith('pad:'));
  // id → 2 chars of 4, name → 4 of 11; A-1 → 1, Rossi → 6; A-2 → 1; "Hafen; Co" fills its 11.
  expect(pads.map(([at, , c]) => [DOC.slice(0, at).split('\n').length, c])).toEqual([[1, 'pad:2'], [1, 'pad:7'], [2, 'pad:1'], [2, 'pad:6'], [3, 'pad:1']]);
});

test('large texts rescan after a pause: until then the old scan stays (marked stale)', () => {
  const big = 'a,b\n' + '1,2\n'.repeat(200_000);
  let s = state(big, { delimiter: ',' });
  s = s.update({ changes: { from: 4, insert: '"x\ny",3\n' } }).state;
  expect(cursorCell(s)).not.toBeNull();
  s = s.update({ effects: rescanCsv.of(null) }).state;
  expect(cursorCell(s.update({ selection: { anchor: 8 } }).state)).toMatchObject({ row: 0, col: 0, line: 2 });
});

test('a field\'s value as the table shows it: quotes removed, doubled quotes undone, text after a quote kept', () => {
  expect(unquoteField('"Hafen; Co"', ';')).toBe('Hafen; Co');
  expect(unquoteField('"say ""hi"""', ',')).toBe('say "hi"');
  expect(unquoteField('plain', ',')).toBe('plain');
  expect(unquoteField('"abc"def', ',')).toBe('abcdef');
});

test('skipped title lines: a quote in them opens nothing, the data keeps its cells (review)', () => {
  const doc = '"Report Q3\na;b\n1;2\n';
  expect(cursorCell(state(doc, { skip: 1 }, doc.indexOf('2')))).toMatchObject({ row: 0, col: 1, line: 3 });
});
