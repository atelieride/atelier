import { expect, test } from 'vitest';
import type { DirEntry } from '@shared/files';
import { foldersToRelist, sameEntries, treeChanged } from './tree-refresh';

// Files lists a folder only when it opens: a path changed on disk (a clone, a rename, a file written from a terminal)
// shows once the nearest folder shown open around it is listed again.

const root = '/p';
const open = (...rels: string[]) => new Set(rels.map((r) => `${root}/${r}`));

test('a clone into a folder lists that folder again (the new one appears, closed)', () => {
  expect(foldersToRelist(['/p/hub/guides/README.md'], root, open('hub'))).toEqual(new Set(['/p/hub']));
  expect(foldersToRelist(['/p/hub/guides'], root, open('hub'))).toEqual(new Set(['/p/hub']));
});

test('nothing open: the root is listed again', () => {
  expect(foldersToRelist(['/p/hub/guides/README.md'], root, open())).toEqual(new Set(['/p']));
  expect(foldersToRelist(['/p/new-tools', '/p/old-tools'], root, open())).toEqual(new Set(['/p']));
});

test('the deepest folder shown open around the path', () => {
  expect(foldersToRelist(['/p/hub/guides/x.md'], root, open('hub', 'hub/guides'))).toEqual(new Set(['/p/hub/guides']));
});

test('a folder open inside a closed one is not shown: its nearest shown ancestor is', () => {
  expect(foldersToRelist(['/p/hub/guides/x.md'], root, open('hub/guides'))).toEqual(new Set(['/p']));
});

test('each folder once, however many paths change in it', () => {
  expect(foldersToRelist(['/p/a/1', '/p/a/2', '/p/b'], root, open('a'))).toEqual(new Set(['/p/a', '/p']));
});

test('the root itself changed (the OS dropped events): every open folder', () => {
  expect(foldersToRelist(['/p'], root, open('a'))).toBe('all');
});

test('paths outside the project change nothing (files opened from elsewhere)', () => {
  expect(foldersToRelist(['/elsewhere/x.md', '/pp/x'], root, open())).toEqual(new Set());
});

test('a project opened through a link: rows and events are real paths, under the real root', () => {
  const real = '/private/var/p';
  expect(foldersToRelist(['/private/var/p/hub/x'], real, new Set(['/private/var/p/hub']))).toEqual(new Set(['/private/var/p/hub']));
});

test('a huge burst of changed paths (a big checkout) gathers without overflowing', () => {
  expect(() => treeChanged(new Array(300_000).fill('/p/x'))).not.toThrow();
});

const e = (name: string, dir = false): DirEntry => ({ name, path: `/p/${name}`, rel: name, dir, hidden: false });

test('sameEntries: the same rows in the same order, or not', () => {
  expect(sameEntries([e('a', true), e('b')], [e('a', true), e('b')])).toBe(true);
  expect(sameEntries(null, [e('a')])).toBe(false);
  expect(sameEntries([e('a')], [e('a'), e('b')])).toBe(false);
  expect(sameEntries([e('a', true)], [e('a')])).toBe(false);
  expect(sameEntries([e('a')], [{ ...e('a'), hidden: true }])).toBe(false);
});
