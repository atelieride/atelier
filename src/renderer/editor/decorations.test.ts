import { EditorState } from '@codemirror/state';
import { expect, test } from 'vitest';
import { diffRulerSource, gitMarkLines, gitMarksField, setGitMarks, setTokens, tokenField } from './decorations';
import { unifiedDoc } from './linediff';

test('the overview ruler\'s changes in Margin: the margin\'s marks as lines', () => {
  let s = EditorState.create({ doc: 'a\nb\nc\nd\n', extensions: [gitMarksField] });
  expect(gitMarkLines(s)).toEqual([]);
  s = s.update({ effects: setGitMarks.of(new Map([[2, 'mod'], [4, 'add'], [1, 'del']])) }).state;
  expect(gitMarkLines(s)).toEqual([{ line: 1, kind: 'del' }, { line: 2, kind: 'mod' }, { line: 4, kind: 'add' }]);
  // A view without the margin (a revision): none.
  expect(gitMarkLines(EditorState.create({ doc: 'a' }))).toEqual([]);
});

test('the overview ruler\'s changes in Diff: the added and removed rows, an added row\'s file line for its tooltip', () => {
  const d = unifiedDoc('a\nb\nc\n', 'a\nB\nc\nd\n')!;
  const src = diffRulerSource(d);
  expect(src.changes()).toEqual([{ line: 2, kind: 'del' }, { line: 3, kind: 'add' }, { line: 5, kind: 'add' }]);
  expect(src.fileLine(3)).toBe(2);
  expect(src.fileLine(5)).toBe(4);
  expect(src.fileLine(2)).toBeNull();
});

test('colors follow the text while typing (positions shift with the edits)', () => {
  let s = EditorState.create({ doc: 'const a = 1;', extensions: [tokenField] });
  s = s.update({ effects: setTokens.of({ spans: [0, 5, 0], colors: ['#F472B6'] }) }).state;
  s = s.update({ changes: { from: 0, insert: '// x\n' } }).state;
  const ranges: [number, number][] = [];
  s.field(tokenField).between(0, s.doc.length, (from, to) => { ranges.push([from, to]); });
  expect(ranges).toEqual([[5, 10]]);
});
