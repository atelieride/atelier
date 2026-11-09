import { afterEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { chunk, mentionPath, mentionTarget, selectionLines } from './mention';

afterEach(() => resetPlatformForTests());
import { Text } from '@codemirror/state';

test('Mention: path relative to the session folder, quoted if it has spaces', () => {
  expect(mentionPath('/p/app/src/a.ts', '/p/app', '/p')).toBe('@src/a.ts ');
  expect(mentionPath('/p/lib/b.ts', '/p/app', '/p')).toBe('@../lib/b.ts ');
  expect(mentionPath('/p/My Docs/c.md', '/p', '/p')).toBe('@"My Docs/c.md" ');
  expect(mentionPath('/p/a.ts', null, '/p')).toBe('@a.ts ');
});

test('Mention of a file outside the project: its absolute path', () => {
  expect(mentionPath('/Users/me/Downloads/x.json', '/p/app', '/p', { start: 3, end: 9 })).toBe('@/Users/me/Downloads/x.json#L3-9 ');
  expect(mentionPath('/p-twin/a.ts', '/p', '/p')).toBe('@/p-twin/a.ts ');
  expect(mentionPath('/Users/me/My Notes/n.md', '/p', '/p')).toBe('@"/Users/me/My Notes/n.md" ');
});

test('Windows: segments compare in any case; a session on another drive gets the absolute path', () => {
  initPlatform('win32');
  expect(mentionPath('C:/Work/App/src/a.ts', 'c:/work/app', 'C:/Work')).toBe('@src/a.ts ');
  expect(mentionPath('C:/Work/Lib/b.ts', 'C:/work/app', 'C:/Work')).toBe('@../Lib/b.ts ');
  expect(mentionPath('c:/work/a.ts', null, 'C:/Work')).toBe('@a.ts ');
  // A session started on D: (a project on C:): never "../../C:/…".
  expect(mentionPath('C:/Work/src/a.ts', 'D:/scratch', 'C:/Work', { start: 2, end: 2 })).toBe('@C:/Work/src/a.ts#L2 ');
});

test('POSIX keeps case-sensitive segments', () => {
  expect(mentionPath('/p/App/a.ts', '/p/app', '/p')).toBe('@../App/a.ts ');
});

test('Paste in chunks to stay under the term:input limit', () => {
  expect(chunk('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  expect(chunk('', 3)).toEqual([]);
});

test('chunk never splits a surrogate pair (an emoji at the boundary goes whole into the next piece)', () => {
  const parts = chunk('ab😀cd', 3);
  expect(parts.join('')).toBe('ab😀cd');
  for (const p of parts) expect(p).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
  expect(parts).toEqual(['ab', '😀c', 'd']);
  // Only astral characters, size 1: each piece still holds a whole one.
  expect(chunk('😀😀', 1)).toEqual(['😀', '😀']);
});

test('mention with lines: as Claude Code writes it from the IDE (@file#L10-24, a single line @file#L7)', () => {
  expect(mentionPath('/p/src/a.ts', '/p', '/p', { start: 10, end: 24 })).toBe('@src/a.ts#L10-24 ');
  expect(mentionPath('/p/src/a.ts', '/p', '/p', { start: 7, end: 7 })).toBe('@src/a.ts#L7 ');
  expect(mentionPath('/p/my docs/a.md', '/p', '/p', { start: 1, end: 2 })).toBe('@"my docs/a.md#L1-2" ');
});

test('selection lines: a selection ending at the start of a line does not count that line; empty = no lines', () => {
  const doc = Text.of(['one', 'two', 'three', 'four']);
  const at = (line: number, col = 0) => doc.line(line).from + col;
  expect(selectionLines(doc, at(2, 1), at(3, 2))).toEqual({ start: 2, end: 3 });
  expect(selectionLines(doc, at(2), at(4))).toEqual({ start: 2, end: 3 });
  expect(selectionLines(doc, at(3, 1), at(3, 1))).toBeNull();
  expect(selectionLines(doc, at(1, 1), at(1, 2))).toEqual({ start: 1, end: 1 });
});

test('project opened through a link (/var → /private/var): the real prefix goes back to the terminal one', () => {
  expect(mentionTarget('/private/var/x/proj/src/a.ts', '/var/x/proj', '/private/var/x/proj')).toBe('/var/x/proj/src/a.ts');
  // Nested repo: the path stays whole (previously a repo-relative rel lost "api/").
  expect(mentionTarget('/private/var/x/proj/api/src/a.ts', '/var/x/proj', '/private/var/x/proj')).toBe('/var/x/proj/api/src/a.ts');
  // Root without a link, or file outside the real root: unchanged.
  expect(mentionTarget('/p/a.ts', '/p', '/p')).toBe('/p/a.ts');
  expect(mentionTarget('/elsewhere/a.ts', '/var/x/proj', '/private/var/x/proj')).toBe('/elsewhere/a.ts');
  expect(mentionTarget('/private/var/x/project2/a.ts', '/var/x/proj', '/private/var/x/proj')).toBe('/private/var/x/project2/a.ts');
  expect(mentionPath(mentionTarget('/private/var/x/proj/api/a.ts', '/var/x/proj', '/private/var/x/proj'), '/var/x/proj', '/var/x/proj')).toBe('@api/a.ts ');
});
