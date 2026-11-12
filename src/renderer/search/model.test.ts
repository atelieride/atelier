import { expect, test } from 'vitest';
import type { SearchFile, SearchLine } from '@shared/search';
import { buildRows, fileKey, matchKey, mergeUnsaved, nearestMatch, previewWindow, resultsText, stepResult, totals } from './model';

const ln = (line: number, text: string, ranges: [number, number][], start = 0): SearchLine => ({ line, text, start, ranges });
const file = (rel: string, lines: SearchLine[]): SearchFile => ({ path: `/p/${rel}`, rel, size: 10, lines });
const A = file('a.ts', [ln(1, 'token token', [[0, 5], [6, 11]]), ln(4, 'a token', [[2, 7]])]);
const B = file('b.ts', [ln(2, 'token', [[0, 5]])]);
const none = new Set<string>();

test('rows list a file and its matches, one per range; collapsed files show no matches', () => {
  const rows = buildRows([A, B], none, none);
  expect(rows.map((r) => r.key)).toEqual([
    fileKey(A.path), matchKey(A.path, 1, 0), matchKey(A.path, 1, 1), matchKey(A.path, 4, 0), fileKey(B.path), matchKey(B.path, 2, 0)
  ]);
  expect(rows[0]).toMatchObject({ kind: 'file', count: 3, collapsed: false });
  const folded = buildRows([A, B], new Set([fileKey(A.path)]), none);
  expect(folded.map((r) => r.key)).toEqual([fileKey(A.path), fileKey(B.path), matchKey(B.path, 2, 0)]);
  expect(folded[0]).toMatchObject({ collapsed: true, count: 3 });
});

test('dismissed rows and files leave the rows; a file with every match dismissed leaves too', () => {
  const d = buildRows([A, B], none, new Set([matchKey(A.path, 1, 1)]));
  expect(d[0]).toMatchObject({ count: 2 });
  expect(d.map((r) => r.key)).not.toContain(matchKey(A.path, 1, 1));
  expect(buildRows([A, B], none, new Set([fileKey(A.path)])).map((r) => r.key)).toEqual([fileKey(B.path), matchKey(B.path, 2, 0)]);
  expect(buildRows([B], none, new Set([matchKey(B.path, 2, 0)]))).toEqual([]);
});

test('stepResult walks match rows across files and wraps both ways', () => {
  const rows = buildRows([A, B], none, none);
  const last = matchKey(B.path, 2, 0);
  const first = matchKey(A.path, 1, 0);
  expect(stepResult(rows, null, 1)).toBe(first);
  expect(stepResult(rows, null, -1)).toBe(last);
  expect(stepResult(rows, matchKey(A.path, 4, 0), 1)).toBe(last);
  expect(stepResult(rows, last, 1)).toBe(first);
  expect(stepResult(rows, first, -1)).toBe(last);
  expect(stepResult(rows, fileKey(B.path), 1)).toBe(last);
  expect(stepResult(rows, fileKey(B.path), -1)).toBe(matchKey(A.path, 4, 0));
  expect(stepResult([], null, 1)).toBeNull();
});

test("previewWindow drops leading whitespace and marks every range, the row's own one strong", () => {
  const p = previewWindow(ln(1, '    foo bar foo', [[4, 7], [12, 15]], 0), 1);
  expect(p).toEqual({ text: 'foo bar foo', marks: [[0, 3], [8, 11]], strong: 1, cut: false });
});

test('previewWindow starts a few characters before a far match and says it is cut', () => {
  const text = 'x'.repeat(100) + 'needle' + ' end';
  const p = previewWindow(ln(1, text, [[100, 106]], 0), 0, 10);
  expect(p.cut).toBe(true);
  expect(p.text).toBe('x'.repeat(10) + 'needle end');
  expect(p.marks).toEqual([[10, 16]]);
  expect(p.strong).toBe(0);
});

test("previewWindow shifts ranges by the kept text's start and clamps those outside it", () => {
  const kept = ln(1, 'abc needle def', [[0, 3], [64, 70], [500, 505]], 60);
  const p = previewWindow(kept, 1);
  expect(p.marks).toEqual([[4, 10]]);
  expect(p.strong).toBe(0);
  expect(p.cut).toBe(true);
  const own = previewWindow(kept, 2);
  expect(own).toEqual({ text: '…', marks: [], strong: -1, cut: false });
  const before = previewWindow(ln(1, 'abc', [[0, 2]], 60), 0);
  expect(before.text).toBe('…');
});

test('previewWindow clamps a range that straddles the end of the kept text', () => {
  const p = previewWindow(ln(1, 'abc def', [[4, 12]], 0), 0);
  expect(p.marks).toEqual([[4, 7]]);
  expect(p.strong).toBe(0);
});

test('previewWindow never starts inside a surrogate pair', () => {
  const text = '😀'.repeat(40) + 'hit';
  const p = previewWindow(ln(1, text, [[80, 83]], 0), 0, 5);
  expect(p.text.charCodeAt(0)).toBeLessThan(0xdc00);
  expect(p.text.endsWith('hit')).toBe(true);
  const m = p.marks[0]!;
  expect(p.text.slice(m[0], m[1])).toBe('hit');
});

test('totals count undismissed results and the files that still have some', () => {
  expect(totals([A, B], none)).toEqual({ results: 4, files: 2 });
  expect(totals([A, B], new Set([fileKey(A.path), matchKey(B.path, 2, 0)]))).toEqual({ results: 0, files: 0 });
  expect(totals([A, B], new Set([matchKey(A.path, 1, 0)]))).toEqual({ results: 3, files: 2 });
});

const spec = { query: 'token', matchCase: false, wholeWord: false, regex: false };

test('resultsText has a header, one line per matching line and leaves dismissed rows out', () => {
  const f = file('src/auth/session.ts', [ln(1, "import { TokenStore } from './tokens';", [[9, 14]]), ln(8, '  const store = new TokenStore();', [[18, 23]])]);
  const t = resultsText(spec, [f], none).split('\n');
  expect(t[0]).toBe('Search "token" (match case off, whole word off, regex off) — 2 results in 1 file');
  expect(t[1]).toBe("src/auth/session.ts:1  import { TokenStore } from './tokens';");
  expect(t[2]).toBe('src/auth/session.ts:8  const store = new TokenStore();');
  const d = resultsText({ ...spec, regex: true, matchCase: true }, [f], new Set([matchKey(f.path, 1, 0)])).split('\n');
  expect(d[0]).toBe('Search "token" (match case on, whole word off, regex on) — 1 result in 1 file');
  expect(d).toHaveLength(2);
});

test('resultsText stops at the cap and counts the rest', () => {
  const many = file('m.ts', Array.from({ length: 5 }, (_, i) => ln(i + 1, 'token', [[0, 5]])));
  const t = resultsText(spec, [many], none, 3).split('\n');
  expect(t).toHaveLength(5);
  expect(t[4]).toBe('…and 2 more results');
  expect(resultsText(spec, [many], none).split('\n')).toHaveLength(6);
});

test('nearestMatch finds a match moved by two lines and gives up past the distance', () => {
  const lines = ['a', 'b', 'c', 'x token', 'e', 'f', 'g', 'h', 'i', 'j'];
  const ranges = (l: string): [number, number][] => { const i = l.indexOf('token'); return i < 0 ? [] : [[i, i + 5]]; };
  expect(nearestMatch(lines, ranges, 2, 2)).toEqual({ line: 4, from: 2, to: 7 });
  expect(nearestMatch(lines, ranges, 4, 2)).toEqual({ line: 4, from: 2, to: 7 });
  expect(nearestMatch(lines, ranges, 10, 0)).toBeNull();
  expect(nearestMatch(lines, ranges, 8, 0, 4)).toEqual({ line: 4, from: 2, to: 7 });
  expect(nearestMatch(lines, ranges, 9, 0, 4)).toBeNull();
});

test("mergeUnsaved replaces a dirty file's disk result in place, adds new ones in order and drops stale ones", () => {
  const C = file('c.ts', [ln(1, 'token', [[0, 5]])]);
  const aBuf = { ...A, lines: [ln(9, 'token', [[0, 5]])] };
  const nBuf = file('b2.ts', [ln(1, 'token', [[0, 5]])]);
  const out = mergeUnsaved([A, B, C], [aBuf, nBuf], new Set([A.path, B.path, nBuf.path]));
  expect(out.map((f) => f.rel)).toEqual(['a.ts', 'b2.ts', 'c.ts']);
  expect(out[0]).toBe(aBuf);
  expect(mergeUnsaved([A, B], [], new Set())).toEqual([A, B]);
});
