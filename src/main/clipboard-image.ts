import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// An image on the clipboard (screenshot, copy from an app) pasted into the terminal becomes a png file whose path is
// pasted instead: Claude Code recognizes an image path and attaches it as [Image #N].

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;
const NAME = /^clipboard-[\w-]+\.png$/;

const pad = (n: number) => String(n).padStart(2, '0');

export function clipboardImageName(now: Date, rand: string): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `clipboard-${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${rand}.png`;
}

/** Removes images pasted more than a day ago: Claude reads them when it receives them, they are useless afterwards. */
function prune(dir: string, now: Date): void {
  for (const f of readdirSync(dir)) {
    if (!NAME.test(f)) continue;
    const p = join(dir, f);
    try { if (now.getTime() - statSync(p).mtimeMs > KEEP_MS) unlinkSync(p); } catch { /* already gone */ }
  }
}

/** Saves the clipboard image's png bytes to a private file (0600, directory 0700) and returns its path; null if there is none. */
export function saveClipboardImage(png: Buffer | null, dir: string, now = new Date(), rand = randomBytes(4).toString('hex').toUpperCase()): string | null {
  if (!png || png.length === 0 || png.length > MAX_IMAGE_BYTES) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  prune(dir, now);
  const p = join(dir, clipboardImageName(now, rand));
  writeFileSync(p, png, { mode: 0o600, flag: 'wx' });
  return p;
}
