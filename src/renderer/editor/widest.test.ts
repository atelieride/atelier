import { expect, test } from 'vitest';
import { Compartment, EditorState, Text } from '@codemirror/state';
import { lineColumns, widestColumns, widestField } from './widest';

// The document's widest line, so the code's width doesn't depend on which lines CodeMirror has drawn.

test('a line is as wide as its columns, tabs up to their stops', () => {
  expect(lineColumns('', 4)).toBe(0);
  expect(lineColumns('abc', 4)).toBe(3);
  expect(lineColumns('\tx', 4)).toBe(5);
  expect(lineColumns('ab\tx', 4)).toBe(5);
  expect(lineColumns('ab\tx', 8)).toBe(9);
  expect(widestColumns(Text.of(['a', 'abcdef', '\t\tx', 'ab']), 4)).toBe(9);
  expect(widestColumns(Text.of(['']), 4)).toBe(0);
});

test('the widest follows the edits: a wider line wins, the widest one shortened rescans, others leave it alone', () => {
  const lines = ['short', 'x'.repeat(40), 'mid line', ...Array.from({ length: 300 }, (_, i) => `line ${i}`)];
  let s = EditorState.create({ doc: lines.join('\n'), extensions: widestField });
  expect(s.field(widestField)).toBe(40);
  const at = (n: number) => s.doc.line(n);
  // Typing on a short line: unchanged.
  s = s.update({ changes: { from: at(1).to, insert: '!!' } }).state;
  expect(s.field(widestField)).toBe(40);
  // A line grows past the widest.
  s = s.update({ changes: { from: at(3).to, insert: 'y'.repeat(50) } }).state;
  expect(s.field(widestField)).toBe(58);
  // That line shortened: the next widest is found again.
  s = s.update({ changes: { from: at(3).from + 8, to: at(3).to } }).state;
  expect(s.field(widestField)).toBe(40);
  // The widest deleted with its neighbours, a paste of wider lines, then everything gone.
  s = s.update({ changes: { from: at(1).from, to: at(3).to } }).state;
  expect(s.field(widestField)).toBe(8);
  s = s.update({ changes: { from: 0, insert: `${'z'.repeat(70)}\n${'w'.repeat(20)}\n` } }).state;
  expect(s.field(widestField)).toBe(70);
  s = s.update({ changes: { from: 0, to: s.doc.length } }).state;
  expect(s.field(widestField)).toBe(0);
});

test('a new tab size measures again', () => {
  const tabs = new Compartment();
  let s = EditorState.create({ doc: '\t\tx\nabcdef', extensions: [widestField, tabs.of(EditorState.tabSize.of(4))] });
  expect(s.field(widestField)).toBe(9);
  s = s.update({ effects: tabs.reconfigure(EditorState.tabSize.of(8)) }).state;
  expect(s.field(widestField)).toBe(17);
});
