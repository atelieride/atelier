import { EditorSelection, EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { expect, test } from 'vitest';
import type { SearchSpec } from '@shared/search';
import { findInFilesHighlight, foundRange, hitDecorations, searchHitsSpec, setSearchHits } from './find-in-files-ext';

const SPEC: SearchSpec = { query: 'token', matchCase: false, wholeWord: false, regex: false };
const DOC = 'token a\nb Token token\nc';

/** The marks as [from, to, class]. */
function marks(set: DecorationSet): [number, number, string][] {
  const out: [number, number, string][] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, d) => { out.push([from, to, String(d.spec.class)]); });
  return out;
}

const all = (s: EditorState) => [{ from: 0, to: s.doc.length }];

test('with a spec, every occurrence in the visible ranges is marked, the one the selection holds strongly; null clears', () => {
  let s = EditorState.create({ doc: DOC, extensions: [findInFilesHighlight], selection: EditorSelection.single(10, 15) });
  expect(searchHitsSpec(s)).toBeNull();
  expect(marks(hitDecorations(s, all(s)))).toEqual([]);
  s = s.update({ effects: setSearchHits.of(SPEC) }).state;
  expect(searchHitsSpec(s)).toEqual(SPEC);
  expect(marks(hitDecorations(s, all(s)))).toEqual([[0, 5, 'cm-fif-hit'], [10, 15, 'cm-fif-hit-strong'], [16, 21, 'cm-fif-hit']]);
  // Only what the editor shows is marked.
  expect(marks(hitDecorations(s, [{ from: 8, to: 15 }]))).toEqual([[10, 15, 'cm-fif-hit-strong']]);
  // The selection moved off the match: none is strong.
  s = s.update({ selection: { anchor: 2 } }).state;
  expect(marks(hitDecorations(s, all(s))).map((m) => m[2])).toEqual(['cm-fif-hit', 'cm-fif-hit', 'cm-fif-hit']);
  // The marks follow the options (match case) and edits.
  s = s.update({ effects: setSearchHits.of({ ...SPEC, matchCase: true }) }).state;
  expect(marks(hitDecorations(s, all(s)))).toEqual([[0, 5, 'cm-fif-hit'], [16, 21, 'cm-fif-hit']]);
  s = s.update({ changes: { from: 0, insert: 'token ' } }).state;
  expect(marks(hitDecorations(s, all(s))).map((m) => m[0])).toEqual([0, 6, 22]);
  s = s.update({ effects: setSearchHits.of(null) }).state;
  expect(searchHitsSpec(s)).toBeNull();
  expect(marks(hitDecorations(s, all(s)))).toEqual([]);
});

test('a regular expression marks its matches; an invalid one marks nothing', () => {
  let s = EditorState.create({ doc: 'a1 b22 c333', extensions: [findInFilesHighlight] });
  s = s.update({ effects: setSearchHits.of({ ...SPEC, query: '\\d+', regex: true }) }).state;
  expect(marks(hitDecorations(s, all(s))).map((m) => [m[0], m[1]])).toEqual([[1, 2], [4, 6], [8, 11]]);
  s = s.update({ effects: setSearchHits.of({ ...SPEC, query: 'a(', regex: true }) }).state;
  expect(marks(hitDecorations(s, all(s)))).toEqual([]);
});

test('a result\'s match: on its line, else the nearest occurrence a few lines away, else none', () => {
  const doc = ['one', 'two', 'const token = 1;', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'].join('\n');
  const s = EditorState.create({ doc });
  const at = (line: number) => s.doc.line(line).from;
  const found = { line: 3, from: 6, to: 11, spec: SPEC, keepFocus: false };
  expect(foundRange(s, 3, found)).toEqual({ from: at(3) + 6, to: at(3) + 11 });
  // The file changed: two lines were added above the match.
  const moved = EditorState.create({ doc: `x\ny\n${doc}` });
  expect(foundRange(moved, 3, found)).toEqual({ from: moved.doc.line(5).from + 6, to: moved.doc.line(5).from + 11 });
  // Several on the line: the one starting nearest the result's column.
  const two = EditorState.create({ doc: 'token, token and token' });
  expect(foundRange(two, 1, { ...found, line: 1, from: 8, to: 13 })).toEqual({ from: 7, to: 12 });
  // Gone, or too far away: none (the editor goes to the line without a selection).
  expect(foundRange(EditorState.create({ doc: 'nothing here\n'.repeat(20) }), 3, found)).toBeNull();
  const far = EditorState.create({ doc: `${'x\n'.repeat(12)}token` });
  expect(foundRange(far, 3, found)).toBeNull();
  // Columns are UTF-16, as the results give them.
  expect(foundRange(EditorState.create({ doc: '😀 token' }), 1, { ...found, line: 1, from: 3, to: 8 })).toEqual({ from: 3, to: 8 });
});
