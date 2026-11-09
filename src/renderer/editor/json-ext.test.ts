import { describe, expect, test } from 'vitest';
import { EditorState } from '@codemirror/state';
import { foldable, foldedRanges, foldEffect } from '@codemirror/language';
import { cursorInfo, errorField, foldLevelEffects, fromParse, jsonEditorExtensions, markParsed, scanField, setJsonError, setScan } from './json-ext';
import { scanJson } from '../json/scan';

const DOC = [
  '{',
  '  "name": "orbit",',
  '  "server": {',
  '    "port": 8080,',
  '    "cors": {',
  '      "origins": ["a", "b"]',
  '    }',
  '  },',
  '  "list": [1, 2]',
  '}'
].join('\n');

const make = (doc = DOC) => EditorState.create({ doc, extensions: jsonEditorExtensions() });
const line = (s: EditorState, n: number) => s.doc.line(n);

describe('folding from the scan', () => {
  test('a line that opens a block closed later folds from after its bracket', () => {
    const s = make();
    const r = foldable(s, line(s, 3).from, line(s, 3).to)!;
    expect(s.sliceDoc(r.from - 1, r.from)).toBe('{');
    expect(s.sliceDoc(r.to, r.to + 1)).toBe('}');
    expect(foldable(s, line(s, 9).from, line(s, 9).to)).toBeNull();
    expect(foldable(s, line(s, 2).from, line(s, 2).to)).toBeNull();
  });

  test('edits keep the scan current in small documents', () => {
    let s = make();
    s = s.update({ changes: { from: line(s, 9).from, to: line(s, 9).to, insert: '  "list": [\n    1\n  ]' } }).state;
    expect(foldable(s, line(s, 9).from, line(s, 9).to)).not.toBeNull();
  });

  test('large documents: no fold until the idle scan arrives', () => {
    const big = `[\n${Array.from({ length: 60_000 }, (_, i) => `  {"i": ${i}}`).join(',\n')}\n]`;
    let s = make(big);
    expect(s.field(scanField).scan).toBeNull();
    expect(foldable(s, 0, 1)).toBeNull();
    s = s.update({ effects: setScan.of(scanJson(big)) }).state;
    expect(foldable(s, 0, 1)).not.toBeNull();
  });

  test('fold to a level: the blocks at that depth that span lines', () => {
    const s = make();
    const effects = foldLevelEffects(s, 1);
    expect(effects.map((e) => s.sliceDoc(e.value.from - 1, e.value.from) + s.doc.lineAt(e.value.from).number)).toEqual(['{3']);
    expect(foldLevelEffects(s, 2).map((e) => s.doc.lineAt(e.value.from).number)).toEqual([5]);
    const folded = s.update({ effects }).state;
    expect(foldedRanges(folded).size).toBe(1);
    // Every effect is a fold.
    expect(effects.every((e) => e.is(foldEffect))).toBe(true);
  });
});

describe('the path and type at the cursor', () => {
  test('a scalar member: its path, where it starts, its type', () => {
    const s = make();
    const at = DOC.indexOf('8080') + 1;
    expect(cursorInfo(s, at)).toEqual({ path: ['server', 'port'], start: DOC.indexOf('"port"'), info: { type: 'number' } });
    expect(cursorInfo(s, DOC.indexOf('"b"') + 1)).toMatchObject({ path: ['server', 'cors', 'origins', 1], info: { type: 'string', length: 1 } });
  });
  test('a container: its count; the root', () => {
    const s = make();
    expect(cursorInfo(s, DOC.indexOf('"cors"') + 2)).toMatchObject({ path: ['server', 'cors'], info: { type: 'object', count: 1 } });
    expect(cursorInfo(s, DOC.indexOf('"list"'))).toMatchObject({ path: ['list'], info: { type: 'array', count: 2 } });
    expect(cursorInfo(s, 1)).toMatchObject({ path: [], info: { type: 'object', count: 3 } });
  });
  test('no scan yet: nothing', () => {
    const big = `[${'1,'.repeat(300_000)}1]`;
    expect(cursorInfo(make(big), 5)).toBeNull();
  });
});

describe('review fixes', () => {
  const big = `[\n${Array.from({ length: 60_000 }, (_, i) => `  {"i": ${i}}`).join(',\n')}\n]`;
  test('large documents keep a mapped scan while typing: folds and the path stay put until the idle scan', () => {
    let s = make(big);
    s = s.update({ effects: setScan.of(scanJson(big)) }).state;
    s = s.update({ changes: { from: 0, insert: '\n\n' } }).state;
    expect(s.field(scanField).scan).not.toBeNull();
    expect(s.field(scanField).fresh).toBe(false);
    const r = foldable(s, line(s, 3).from, line(s, 3).to)!;
    expect(s.sliceDoc(r.from - 1, r.from)).toBe('[');
    expect(s.sliceDoc(r.to, r.to + 1)).toBe(']');
    expect(cursorInfo(s, s.doc.toString().indexOf('"i": 5}') + 1)).toMatchObject({ path: [5, 'i'] });
  });

  test('positions of the last valid parse map onto the current text until the next valid parse', () => {
    let s = make('{\n  "a": 1,\n  "b": 2\n}');
    const b = s.doc.toString().indexOf('"b"');
    s = s.update({ changes: { from: 2, insert: '"x": ' } }).state;
    expect(s.sliceDoc(fromParse(s, b), fromParse(s, b) + 3)).toBe('"b"');
    s = s.update({ effects: markParsed.of(null) }).state;
    expect(fromParse(s, 5)).toBe(5);
  });

  test('a string longer than the first window still gets its length', () => {
    const long = 'y'.repeat(70_000);
    const doc = `{"s": "${long}"}`;
    expect(cursorInfo(make(doc), 3)).toMatchObject({ path: ['s'], info: { type: 'string', length: 70_000 } });
  });

  test('the quick fix moves with edits made before the next parse', () => {
    let s = make('[1,]');
    s = s.update({ effects: setJsonError.of({ from: 2, to: 3, line: 1, col: 3, message: 'Trailing comma before ]', fix: { label: 'Remove the comma', from: 2, to: 3, insert: '' } }) }).state;
    s = s.update({ changes: { from: 1, insert: '0, ' } }).state;
    expect(s.field(errorField)!.fix).toMatchObject({ from: 5, to: 6 });
    expect(s.sliceDoc(5, 6)).toBe(',');
  });
});

describe('the error field', () => {
  test('set by the parse, mapped through edits, cleared', () => {
    let s = make('[1,]');
    s = s.update({ effects: setJsonError.of({ from: 2, to: 3, line: 1, col: 3, message: 'Trailing comma before ]' }) }).state;
    expect(s.field(errorField)).toMatchObject({ from: 2, to: 3 });
    s = s.update({ changes: { from: 0, insert: '  ' } }).state;
    expect(s.field(errorField)).toMatchObject({ from: 4, to: 5 });
    s = s.update({ effects: setJsonError.of(null) }).state;
    expect(s.field(errorField)).toBeNull();
  });
});
