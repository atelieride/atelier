import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toOut } from './cpath';
import { expect, test } from 'vitest';
import { clipboardImageDir, revealTarget, sanitizeClipboard } from './clipboard-ipc';
import { useMachinePlatform } from '../../tests/support/platform';

// Real files with native paths: the app's platform switch reads the machine's (win32 on Windows).
useMachinePlatform();

test('pasted images: the temp dir on macOS; ATELIER_HOME on Windows, where Claude in a terminal can read them', () => {
  // Files another process reads live under ATELIER_HOME; the packaged GUI's AppData writes
  // land in the package's private copy, which ConPTY shells (and Claude) never see.
  expect(clipboardImageDir('darwin', '/Users/u/Library/Application Support/Atelier', '/var/folders/x/T')).toBe('/var/folders/x/T/atelier-clipboard');
  expect(clipboardImageDir('win32', 'C:\\Users\\u\\.atelier', 'C:\\Users\\u\\AppData\\Local\\Temp')).toBe('C:\\Users\\u\\.atelier\\clipboard');
});

test('clipboard: no NUL, no huge texts, strings only', () => {
  expect(sanitizeClipboard('a\0b')).toBe('ab');
  expect(sanitizeClipboard(42)).toBeNull();
  expect(sanitizeClipboard('')).toBe('');
});

test('Reveal in Finder only inside the project (even through a symlink)', () => {
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-rev-'))));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), '');
  const out = mkdtempSync(join(tmpdir(), 'atl-out-'));
  symlinkSync(out, join(root, 'escapes'));
  expect(revealTarget(root, join(root, 'src', 'a.ts'))).toBe(join(root, 'src', 'a.ts'));
  expect(revealTarget(root, '/etc/hosts')).toBeNull();
  expect(revealTarget(root, join(root, 'escapes'))).toBeNull();
  expect(revealTarget(root, join(root, 'missing.ts'))).toBeNull();
});

test('Reveal in Finder of a file outside the project only when it is granted', () => {
  const root = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-rev-'))));
  const out = toOut(realpathSync(mkdtempSync(join(tmpdir(), 'atl-out-'))));
  writeFileSync(join(out, 'x.json'), '{}');
  const f = join(out, 'x.json');
  expect(revealTarget(root, f)).toBeNull();
  expect(revealTarget(root, f, (p) => (p === f ? f : null))).toBe(f);
  expect(revealTarget(root, join(out, 'y.json'), (p) => (p === f ? f : null))).toBeNull();
});

test('tests only: with a copy log the text is recorded there, the real clipboard is never touched', async () => {
  const { writeClipboard } = await import('./clipboard-ipc');
  const log = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'copies.log');
  const real: string[] = [];
  writeClipboard({ text: 'line 1\nline 2' }, log, (c) => { real.push(c.text); });
  writeClipboard({ text: 'second' }, log, (c) => { real.push(c.text); });
  expect(real).toEqual([]);
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual(['line 1\nline 2', 'second']);
  writeClipboard({ text: 'real' }, undefined, (c) => { real.push(c.text); });
  expect(real).toEqual(['real']);
});

test('a formatted copy (Ask): text and HTML written together; the test log keeps both on one line, reads give the text', async () => {
  const { writeClipboard, readClipboard } = await import('./clipboard-ipc');
  const log = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'copies.log');
  const real: unknown[] = [];
  writeClipboard({ text: '**Done**', html: '<p><strong>Done</strong></p>' }, log, (c) => { real.push(c); });
  expect(real).toEqual([]);
  const { readFileSync } = await import('node:fs');
  expect(JSON.parse(readFileSync(log, 'utf8').trim())).toEqual({ text: '**Done**', html: '<p><strong>Done</strong></p>' });
  expect(await readClipboard(log, () => 'never')).toBe('**Done**');
  writeClipboard({ text: 'a', html: '<p>a</p>' }, undefined, (c) => { real.push(c); });
  expect(real).toEqual([{ text: 'a', html: '<p>a</p>' }]);
});

test('a formatted copy: each flavour is held to the clipboard rules', async () => {
  const { clipboardContent } = await import('./clipboard-ipc');
  expect(clipboardContent('a', undefined)).toEqual({ text: 'a' });
  expect(clipboardContent('a', '<p>a\0</p>')).toEqual({ text: 'a', html: '<p>a</p>' });
  expect(clipboardContent('a', 42)).toBeNull();
  expect(clipboardContent('a', 'x'.repeat(16 * 1024 * 1024 + 1))).toBeNull();
  expect(clipboardContent(7, '<p>a</p>')).toBeNull();
});

test('clipboard: up to 16 MB', () => {
  expect(sanitizeClipboard('x'.repeat(2 * 1024 * 1024))).toHaveLength(2 * 1024 * 1024);
  expect(sanitizeClipboard('x'.repeat(16 * 1024 * 1024 + 1))).toBeNull();
});

test('reading the clipboard over the limit: no truncated text, the user is warned', async () => {
  const { readableClipboard } = await import('./clipboard-ipc');
  expect(readableClipboard('hello')).toBe('hello');
  expect(readableClipboard('x'.repeat(16 * 1024 * 1024 + 1))).toBeNull();
});

test('tests only: with a copy log, reading gives the last text copied there, never the real clipboard', async () => {
  const { readClipboard, writeClipboard } = await import('./clipboard-ipc');
  const log = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'copies.log');
  const real = () => { throw new Error('real clipboard read'); };
  expect(await readClipboard(log, real)).toBe('');
  writeClipboard({ text: 'first' }, log, () => {});
  writeClipboard({ text: 'two\nlines' }, log, () => {});
  expect(await readClipboard(log, real)).toBe('two\nlines');
  expect(await readClipboard(undefined, () => 'real')).toBe('real');
});

test("the system clipboard: a plain copy is writeText; a formatted one is one ClipboardItem with both flavours", async () => {
  const { systemWrite } = await import('./clipboard-ipc');
  const calls: unknown[] = [];
  const clip = { writeText: async (t: string) => { calls.push(['text', t]); }, write: async (items: unknown[]) => { calls.push(['items', items]); } };
  class Item { constructor(readonly parts: Record<string, string>) {} }
  await systemWrite({ text: 'a' }, clip, Item);
  await systemWrite({ text: '**b**', html: '<p><strong>b</strong></p>' }, clip, Item);
  expect(calls).toEqual([['text', 'a'], ['items', [new Item({ 'text/plain': '**b**', 'text/html': '<p><strong>b</strong></p>' })]]]);
});
