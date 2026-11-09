import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { classifyHref, imagePath, linkCandidate } from './links';

// Markdown links on Windows: the renderer's paths are canonical (C:/…); a drive is a path,
// not a URL scheme. The macOS behaviour stays pinned by links.test.ts.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

test('a drive path in a link is a file, not an inert scheme; other schemes stay inert', () => {
  expect(classifyHref('C:/proj/docs/a.md#L3')).toEqual({ kind: 'file', path: 'C:/proj/docs/a.md', line: 3, end: null });
  expect(classifyHref('C:\\proj\\a.md')).toEqual({ kind: 'file', path: 'C:\\proj\\a.md', line: null, end: null });
  expect(classifyHref('javascript:alert(1)')).toEqual({ kind: 'inert' });
  expect(classifyHref('file:///C:/x')).toEqual({ kind: 'inert' });
});

test("image paths fold against the file's drive folder", () => {
  expect(imagePath('./a.png', 'C:/proj/docs/x.md', 'C:/proj')).toBe('C:/proj/docs/a.png');
  expect(imagePath('../img/a.png', 'C:/proj/docs/x.md', 'C:/proj')).toBe('C:/proj/img/a.png');
  expect(imagePath('/img/a.png', 'C:/proj/docs/x.md', 'C:/proj')).toBe('C:/proj/img/a.png');
  expect(imagePath('a.png', 'C:/x.md', 'C:/proj')).toBe('C:/a.png');
});

test("a link resolves against the file's folder, a drive root included", () => {
  expect(linkCandidate('b.md', 'C:/proj/docs/a.md', 'C:/proj')).toEqual({ candidate: 'b.md', cwd: 'C:/proj/docs' });
  expect(linkCandidate('b.md', 'C:/a.md', 'C:/proj')).toEqual({ candidate: 'b.md', cwd: 'C:/' });
  expect(linkCandidate('/b.md', 'C:/proj/docs/a.md', 'C:/proj')).toEqual({ candidate: 'b.md', cwd: 'C:/proj' });
});
