import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { clipboardImageName, saveClipboardImage } from './clipboard-image';
import { expectMode } from '../../tests/support/platform';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const at = new Date(2026, 9, 10, 10, 37, 24);

test('name: date, time and a random suffix, png extension', () => {
  expect(clipboardImageName(at, 'E5BFA596')).toBe('clipboard-2026-10-10-103724-E5BFA596.png');
});

test('image on the clipboard: private png file in the folder, returns its path', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'atl-clip-')), 'paste');
  const p = saveClipboardImage(png, dir, at, 'AB12CD34');
  expect(p).toBe(join(dir, 'clipboard-2026-10-10-103724-AB12CD34.png'));
  expect(readFileSync(p!)).toEqual(png);
  expectMode(p!, 0o600);
  expectMode(dir, 0o700);
});

test('no image on the clipboard: null, no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-clip-'));
  expect(saveClipboardImage(null, dir, at, 'X')).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});

test('huge image (over 30 MB): null, no file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-clip-'));
  expect(saveClipboardImage(Buffer.alloc(30 * 1024 * 1024 + 1), dir, at, 'X')).toBeNull();
  expect(readdirSync(dir)).toEqual([]);
});

test('images pasted more than a day ago are deleted, the rest of the folder is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-clip-'));
  const old = join(dir, 'clipboard-2026-10-08-090000-OLD.png');
  const recent = join(dir, 'clipboard-2026-10-10-090000-NEW.png');
  const other = join(dir, 'notes.txt');
  for (const f of [old, recent, other]) writeFileSync(f, 'x');
  const twoDaysAgo = (at.getTime() - 2 * 86_400_000) / 1000;
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  utimesSync(other, twoDaysAgo, twoDaysAgo);
  saveClipboardImage(png, dir, at, 'NOW');
  expect(readdirSync(dir).sort()).toEqual(['clipboard-2026-10-10-090000-NEW.png', 'clipboard-2026-10-10-103724-NOW.png', 'notes.txt']);
});
