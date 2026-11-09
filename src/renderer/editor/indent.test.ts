import { expect, test } from 'vitest';
import { commentTokens, detectEol, detectIndent, hasMixedEol } from './indent';

test('indent: tab, 2 spaces, 4 spaces, mixed, empty', () => {
  expect(detectIndent('a\n\tb\n\t\tc\n')).toEqual({ unit: '\t', tabSize: 4 });
  expect(detectIndent('a\n  b\n    c\n  d\n')).toEqual({ unit: '  ', tabSize: 2 });
  expect(detectIndent('a\n    b\n        c\n    d\n')).toEqual({ unit: '    ', tabSize: 4 });
  expect(detectIndent('a\n\tb\n  c\n  d\n  e\n')).toEqual({ unit: '  ', tabSize: 2 });
  expect(detectIndent('')).toEqual({ unit: '  ', tabSize: 2 });
  // JSDoc comments ( * ) do not count as an indent of 1.
  expect(detectIndent('/**\n * x\n */\nfunction a() {\n    return 1;\n}\n')).toEqual({ unit: '    ', tabSize: 4 });
});

test('line ending', () => {
  expect(detectEol('a\r\nb\r\n')).toBe('crlf');
  expect(detectEol('a\nb\n')).toBe('lf');
  expect(detectEol('a single line')).toBe('lf');
  expect(detectEol('a\r\nb\nc\n')).toBe('lf');
  // The majority decides: one stray LF in a CRLF file no longer turns every line into LF on save.
  expect(detectEol('a\r\nb\r\nc\r\nd\n')).toBe('crlf');
  expect(detectEol('a\r\nb\r\nc\n')).toBe('crlf');
  // A tie keeps what it was: LF.
  expect(detectEol('a\r\nb\n')).toBe('lf');
});

test('comments per language', () => {
  expect(commentTokens('typescript')).toEqual({ line: '//', block: { open: '/*', close: '*/' } });
  expect(commentTokens('python')).toEqual({ line: '#' });
  expect(commentTokens('html')).toEqual({ block: { open: '<!--', close: '-->' } });
  expect(commentTokens('markdown')).toEqual({ block: { open: '<!--', close: '-->' } });
  expect(commentTokens(null)).toBeNull();
  expect(commentTokens('unknown')).toBeNull();
});

test('mixed line endings: detected (on save they all become the same, the editor says so)', () => {
  expect(hasMixedEol('a\r\nb\nc\r\n')).toBe(true);
  expect(hasMixedEol('a\r\nb\r\n')).toBe(false);
  expect(hasMixedEol('a\nb\n')).toBe(false);
  expect(hasMixedEol('one line')).toBe(false);
  // A lone CR (not part of CRLF) becomes a line break in the editor, so on save: the band says so.
  expect(hasMixedEol('a\rb\n')).toBe(true);
  expect(hasMixedEol('a\r\nb\rc\r\n')).toBe(true);
  expect(hasMixedEol('classic\rmac\r')).toBe(true);
  expect(hasMixedEol('a\r\nb\r\n\r\n')).toBe(false);
});
