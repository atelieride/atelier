import { EditorSelection, EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { SearchQuery } from '@codemirror/search';
import { expect, test } from 'vitest';
import type { SearchSpec } from '@shared/search';
import { findInFilesHighlight, foundRange, hitDecorations, ownTick, scanMatches, searchHitsSpec, setHitRanges, setSearchHits } from './find-in-files-ext';
import { rulerMatches } from './ruler';

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

/** Every match of `q` in `s`, the editor's own way, in one go. */
function allMatches(s: EditorState, q: SearchQuery): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const c = q.getCursor(s);
  for (let m = c.next(); !m.done; m = c.next()) out.push({ from: m.value.from, to: m.value.to });
  return out;
}

test('the ruler\'s matches are found a slice at a time: the same as one pass, never stuck, bounded by a cap', () => {
  // About 1 MB over 20,000 lines, a match every 7th line, a line-anchored regular expression too.
  const doc = Array.from({ length: 20_000 }, (_, i) => (i % 7 === 0 ? `token ${i} ${'y'.repeat(40)}` : 'x'.repeat(50))).join('\n');
  const s = EditorState.create({ doc });
  for (const q of [new SearchQuery({ search: 'token' }), new SearchQuery({ search: '^token \\d+', regexp: true })]) {
    const out: { from: number; to: number }[] = [];
    let at: number | null = 0;
    let slices = 0;
    // A deadline already gone: each call still moves on by one part of the text.
    while (at !== null) { const next = scanMatches(s, q, at, out, 0); expect(next === null || next > at).toBe(true); at = next; slices++; }
    expect(slices).toBeGreaterThan(5);
    expect(out).toEqual(allMatches(s, q));
    // With time to spare, one call does it all.
    const once: { from: number; to: number }[] = [];
    expect(scanMatches(s, q, 0, once, Infinity)).toBeNull();
    expect(once).toEqual(out);
  }
  const capped: { from: number; to: number }[] = [];
  expect(scanMatches(s, new SearchQuery({ search: 'token' }), 0, capped, Infinity, 3)).toBeNull();
  expect(capped).toHaveLength(3);
});

test('the ruler ticks the scanned matches; edits move them along, a match edited away loses its tick', () => {
  let s = EditorState.create({ doc: DOC, extensions: [findInFilesHighlight] });
  expect(s.facet(rulerMatches)).toBeNull();
  s = s.update({ effects: setSearchHits.of(SPEC) }).state;
  // Not scanned yet: nothing to tick.
  expect(s.facet(rulerMatches)).toBeNull();
  const found = allMatches(s, new SearchQuery({ search: 'token' }));
  s = s.update({ effects: setHitRanges.of(found) }).state;
  expect(s.facet(rulerMatches)).toEqual([{ from: 0, to: 5 }, { from: 10, to: 15 }, { from: 16, to: 21 }]);
  s = s.update({ changes: { from: 0, insert: '// ' } }).state;
  expect(s.facet(rulerMatches)).toEqual([{ from: 3, to: 8 }, { from: 13, to: 18 }, { from: 19, to: 24 }]);
  s = s.update({ changes: { from: 13, to: 18 } }).state;
  expect(s.facet(rulerMatches)).toEqual([{ from: 3, to: 8 }, { from: 14, to: 19 }]);
  // The same query again (the next result in this file): the ticks stay as they are, nothing is scanned again.
  const ranges = s.facet(rulerMatches);
  s = s.update({ effects: setSearchHits.of({ ...SPEC }), selection: { anchor: 14, head: 19 } }).state;
  expect(s.facet(rulerMatches)).toBe(ranges);
  expect(searchHitsSpec(s)).toEqual(SPEC);
  // Another query: scanned again before it ticks; none: nothing.
  s = s.update({ effects: setSearchHits.of({ ...SPEC, query: 'a' }) }).state;
  expect(s.facet(rulerMatches)).toBeNull();
  s = s.update({ effects: setSearchHits.of(null) }).state;
  expect(s.facet(rulerMatches)).toBeNull();
});

test('lines too long to read at once (a minified file) are left to the result\'s own tick; the rest is read in bounded parts', () => {
  const q = new SearchQuery({ search: 'token' });
  // About 4 MB on one line, matches all along it.
  const long = `${'x'.repeat(1000)}token`.repeat(4000);
  const one = EditorState.create({ doc: long });
  const out: { from: number; to: number }[] = [];
  const t0 = performance.now();
  expect(scanMatches(one, q, 0, out, 0)).toBeNull();
  expect(performance.now() - t0).toBeLessThan(20);
  expect(out).toEqual([]);
  // Short lines around it are read as usual.
  const mixed = EditorState.create({ doc: `a token\n${long}\nb token` });
  const found: { from: number; to: number }[] = [];
  let at: number | null = 0;
  while (at !== null) at = scanMatches(mixed, q, at, found, 0);
  expect(found).toEqual([{ from: 2, to: 7 }, { from: mixed.doc.length - 5, to: mixed.doc.length }]);
  // The result's own match on such a line keeps its tick; a selection that is no match, or on a short line, adds none.
  const own = mixed.doc.line(2).from + 1000;
  expect(ownTick(mixed.update({ selection: { anchor: own, head: own + 5 } }).state, q)).toEqual({ from: own, to: own + 5 });
  expect(ownTick(mixed.update({ selection: { anchor: own, head: own + 4 } }).state, q)).toBeNull();
  expect(ownTick(mixed.update({ selection: { anchor: 2, head: 7 } }).state, q)).toBeNull();
  expect(ownTick(mixed.update({ selection: { anchor: own } }).state, q)).toBeNull();
});
