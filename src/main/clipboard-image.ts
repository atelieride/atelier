import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// An image on the clipboard (screenshot, copy from an app) pasted into the terminal becomes a png file whose path is
// pasted instead: Claude Code recognizes an image path and attaches it as [Image #N]. An image a paired phone sends
// (a png or a jpeg) is kept the same way, in the same folder.

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;
const NAME = /^clipboard-[\w-]+\.(?:png|jpg)$/;

/** The kinds of image file kept here, by their extension. */
export type ImageExt = 'png' | 'jpg';

const pad = (n: number) => String(n).padStart(2, '0');

export function clipboardImageName(now: Date, rand: string, ext: ImageExt = 'png'): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `clipboard-${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${rand}.${ext}`;
}

/**
 * Removes images pasted more than a day ago: Claude reads them when it receives them, they are useless afterwards. A
 * folder that isn't there has none.
 */
export function pruneClipboardImages(dir: string, now = new Date()): void {
  let files: string[];
  try { files = readdirSync(dir); } catch { return; }
  for (const f of files) {
    if (!NAME.test(f)) continue;
    const p = join(dir, f);
    try { if (now.getTime() - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p); } catch { /* already gone */ }
  }
}

/**
 * Removes one image kept here that no program was ever given (a phone's image whose reference went unused): only a
 * file named as the images kept here are.
 */
export function removeClipboardImage(path: string): void {
  if (!NAME.test(basename(path))) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * Saves an image's bytes (the clipboard's png unless `ext` says otherwise) to a private file (0600, directory 0700)
 * and returns its path; null if there is none.
 */
export function saveClipboardImage(bytes: Buffer | null, dir: string, now = new Date(), rand = randomBytes(4).toString('hex').toUpperCase(), ext: ImageExt = 'png'): string | null {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  pruneClipboardImages(dir, now);
  const p = join(dir, clipboardImageName(now, rand, ext));
  writeFileSync(p, bytes, { mode: 0o600, flag: 'wx' });
  return p;
}
