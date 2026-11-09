import { expect, test } from 'vitest';
import { gutterMarks, unifiedDoc } from './linediff';

test('aggiunta, modifica, rimozione', () => {
  const orig = 'a\nb\nc\nd\n';
  const cur = 'a\nB\nc\nnuova\n';
  // b→B modified (line 2); d removed and "nuova" added in its place → modified (line 4)
  expect([...gutterMarks(orig, cur)!]).toEqual([[2, 'mod'], [4, 'mod']]);
  expect([...gutterMarks('a\nb\n', 'a\nb\nc\n')!]).toEqual([[3, 'add']]);
  expect([...gutterMarks('a\nb\nc\n', 'a\nc\n')!]).toEqual([[2, 'del']]);
  expect([...gutterMarks('a\nb\n', '')!]).toEqual([[1, 'del']]);
});
test('new file: all added; identical: no marks', () => {
  expect([...gutterMarks('', 'x\ny\n')!]).toEqual([[1, 'add'], [2, 'add']]);
  expect(gutterMarks('a\n', 'a\n')!.size).toBe(0);
});
test('unified document with old and new numbers', () => {
  const d = unifiedDoc('a\nb\nc\n', 'a\nB\nc\n')!;
  expect(d.text).toBe('a\nb\nB\nc');
  expect(d.lines).toEqual([
    { kind: 'ctx', oldNo: 1, newNo: 1 },
    { kind: 'del', oldNo: 2, newNo: null },
    { kind: 'add', oldNo: null, newNo: 2 },
    { kind: 'ctx', oldNo: 3, newNo: 3 }
  ]);
});

test('huge, almost entirely different files: give up quickly instead of freezing the window', () => {
  const a = Array.from({ length: 10000 }, (_, i) => `riga ${i} versione a ${i * 7}`).join('\n');
  const b = Array.from({ length: 10000 }, (_, i) => `riga ${i} versione b ${i * 13}`).join('\n');
  const t0 = performance.now();
  expect(gutterMarks(a, b)).toBeNull();
  expect(unifiedDoc(a, b)).toBeNull();
  expect(performance.now() - t0).toBeLessThan(1500);
});

import { minimalChange } from './linediff';
test('minimalChange: only the changed part is replaced (common prefix and suffix stay)', () => {
  expect(minimalChange('abcXdef', 'abcYYdef')).toEqual({ from: 3, to: 4, insert: 'YY' });
  expect(minimalChange('riga1\nriga2\n', 'riga1\nriga2\nriga3\n')).toEqual({ from: 12, to: 12, insert: 'riga3\n' });
  expect(minimalChange('uguale', 'uguale')).toBeNull();
  expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' });
});

import { wordMarks } from './linediff';
// Changed words in the Diff view: rows of a block paired in order, words only when the rows
// are alike enough.
const doc = (a: string, b: string) => unifiedDoc(a, b)!;
const text = (d: ReturnType<typeof doc>, m: { line: number; from: number; to: number }) => d.text.split('\n')[m.line]!.slice(m.from, m.to);

test('wordMarks: a renamed constant and a new value — the old words on the removed row, the new ones on the added row', () => {
  const d = doc('a\nconst TTL = 60 * 30;\nb\n', 'a\nconst TTL_SECONDS = 60 * 45;\nb\n');
  const marks = wordMarks(d);
  expect(marks.filter((m) => m.kind === 'del').map((m) => text(d, m))).toEqual(['TTL', '30']);
  expect(marks.filter((m) => m.kind === 'add').map((m) => text(d, m))).toEqual(['TTL_SECONDS', '45']);
  expect(new Set(marks.map((m) => d.lines[m.line]!.kind === m.kind))).toEqual(new Set([true]));
});

test('wordMarks: rows paired in order — two removed, one added: only the first pair; added or removed alone: none', () => {
  const d = doc('x\nreturn this.tokens.get(token);\nfoo();\ny\n', 'x\nconst rec = this.tokens.get(token);\ny\n');
  const marks = wordMarks(d);
  expect(marks.map((m) => [m.kind, text(d, m)])).toEqual([['del', 'return'], ['add', 'const rec =']]);
  expect(wordMarks(doc('a\n', 'a\nnew line\n'))).toEqual([]);
  expect(wordMarks(doc('a\nold line\n', 'a\n'))).toEqual([]);
});

test('wordMarks: rows with little in common change whole (their tint says it); very long rows are skipped', () => {
  expect(wordMarks(doc('import { a } from "b";\n', 'export default function render(): void {}\n'))).toEqual([]);
  const long = `const x = [${'1, '.repeat(400)}];`;
  expect(wordMarks(doc(`${long}\n`, `${long.replace('const', 'let')}\n`))).toEqual([]);
});

test('wordMarks: adjacent changed words merge into one mark, spaces between them included', () => {
  const d = doc('call(a, b);\n', 'call(c, d);\n');
  expect(wordMarks(d).map((m) => [m.kind, text(d, m)])).toEqual([['del', 'a, b'], ['add', 'c, d']]);
});
