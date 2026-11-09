import { expect, test } from 'vitest';
import { locate, type Row } from './trigger-view';

const row = (y: number, text: string, wide: number[] = []): Row => {
  // Characters at the indexes in `wide` take two cells (CJK, emoji).
  const cellOf: number[] = [];
  let x = 0;
  for (let i = 0; i < text.length; i++) { cellOf.push(x); x += wide.includes(i) ? 2 : 1; }
  cellOf.push(x);
  return { y, text, cellOf };
};

test('the newest occurrence of each matched text, in cells', () => {
  const rows = [row(0, 'ERROR old'), row(1, 'ok'), row(2, 'x ERROR y')];
  expect(locate(rows, ['ERROR'], () => false)).toEqual([{ y: 2, x: 2, width: 5, text: 'ERROR' }]);
});

test('already highlighted places are skipped; two matches of the same text take two places', () => {
  const rows = [row(0, 'ERROR'), row(1, 'ERROR and ERROR')];
  const taken = (y: number, x: number) => y === 1 && x === 10;
  expect(locate(rows, ['ERROR', 'ERROR'], taken)).toEqual([{ y: 1, x: 0, width: 5, text: 'ERROR' }, { y: 0, x: 0, width: 5, text: 'ERROR' }]);
  // Nothing left to highlight: nothing.
  expect(locate([row(0, 'ERROR')], ['ERROR'], () => true)).toEqual([]);
  expect(locate([row(0, 'fine')], ['ERROR'], () => false)).toEqual([]);
});

test('wide characters: columns are cells, not string indexes', () => {
  expect(locate([row(0, '日本 ERROR', [0, 1])], ['ERROR'], () => false)).toEqual([{ y: 0, x: 5, width: 5, text: 'ERROR' }]);
  expect(locate([row(0, 'a 日本', [2, 3])], ['日本'], () => false)).toEqual([{ y: 0, x: 2, width: 4, text: '日本' }]);
});
