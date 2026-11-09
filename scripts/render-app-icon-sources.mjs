// The app icons rendered as images (scripts/render-app-icons.mjs) and the print of each one's Icon Composer source:
// the render writes the prints to assets/brand/app-icon-sources.json, and a test compares them with the sources as they
// are now, so an .icon changed without rendering again fails instead of shipping a stale image.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** [the Icon Composer source in build/, the PNG in assets/brand/]. */
export const APP_ICONS = [
  ['AppIcon.icon', 'app-icon-aurora.png'],
  ['AppIcon-Docsy.icon', 'app-icon-docsy.png']
];

/** A SHA-256 over an .icon folder: every file's path (POSIX, sorted) and content; Finder's .DS_Store left out. */
export function iconSourcePrint(dir) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== '.DS_Store')
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update('\0');
  return hash.digest('hex');
}
