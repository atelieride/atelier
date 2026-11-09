import { expect, test } from 'vitest';
import { terminalPasteText, clipboardPayload } from './paste';

test('pasting into the terminal: no ESC or controls that close the bracketed paste or run commands', () => {
  const evil = 'echo hi\x1b[201~\rtouch /tmp/pwned\r';
  const out = terminalPasteText(evil);
  expect(out).not.toContain('\x1b');
  expect(out).toBe('echo hi[201~\rtouch /tmp/pwned\r');
  expect(terminalPasteText('a\tb\nc\r\nd\x07\x00\x9b')).toBe('a\tb\nc\r\nd');
});

test('paste sequence: a single bracketed paste, in chunks, without splitting emoji or newlines', async () => {
  const { pasteSequence } = await import('./paste');
  expect(pasteSequence('a\r\nb\nc', false, 100)).toEqual(['a\rb\rc']);
  expect(pasteSequence('ab', true, 100)).toEqual(['\x1b[200~', 'ab', '\x1b[201~']);
  // the emoji (surrogate pair) is not split across two chunks
  const parts = pasteSequence('x😀y', false, 2);
  expect(parts.join('')).toBe('x😀y');
  expect(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
  // ESC stripped first of all: a chunk cannot close the bracketed paste
  expect(pasteSequence('a\x1b[201~b', true, 3).slice(1, -1).join('')).toBe('a[201~b');
  expect(pasteSequence('', true, 10)).toEqual([]);
});

test('paste: the text if there is any, otherwise the path of the saved image', async () => {
  let asked = 0;
  const save = async () => { asked++; return { path: '/tmp/x/clipboard-2026-10-10-103724-AB.png' }; };
  expect(await clipboardPayload('ciao', save)).toBe('ciao');
  expect(asked).toBe(0);
  expect(await clipboardPayload('', save)).toBe('/tmp/x/clipboard-2026-10-10-103724-AB.png');
  expect(await clipboardPayload('', async () => null)).toBe('');
  // Text too large (null): stays null for the warning, no image in its place.
  expect(await clipboardPayload(null, save)).toBeNull();
  expect(asked).toBe(1);
});

test('image too large: nothing pasted but a warning (before, nothing happened)', async () => {
  let warned = 0;
  expect(await clipboardPayload('', async () => ({ tooLarge: true }), () => { warned++; })).toBe('');
  expect(warned).toBe(1);
  expect(await clipboardPayload('', async () => ({ path: '/tmp/x.png' }), () => { warned++; })).toBe('/tmp/x.png');
  expect(warned).toBe(1);
});

test('files copied in Finder (⌘C) paste their escaped paths, like a drop; blobs without a path (a copied image) do not', async () => {
  const { copiedFilesText } = await import('./paste');
  const shot = { name: 'Screen Shot.png' } as File;
  const doc = { name: 'a.txt' } as File;
  const blob = { name: 'image.png' } as File;
  const paths = new Map<File, string | null>([[shot, '/Users/me/Desktop/Screen Shot.png'], [doc, '/Users/me/a.txt'], [blob, null]]);
  const pathFor = (f: File) => paths.get(f) ?? null;
  expect(copiedFilesText([shot, doc], pathFor)).toBe('/Users/me/Desktop/Screen\\ Shot.png /Users/me/a.txt ');
  // A pasted image from an app arrives as a file with no path on disk: the image route handles it.
  expect(copiedFilesText([blob], pathFor)).toBeNull();
  expect(copiedFilesText([], pathFor)).toBeNull();
});
