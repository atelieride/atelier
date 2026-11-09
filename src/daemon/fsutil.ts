import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathStyle } from '@shared/platform';

/**
 * Writes to a temporary file next to it, flushed to disk, then renames: no reader ever sees a half-written file, and a
 * crash or power cut right after the rename never leaves an empty one. A failed write leaves no temporary file behind.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, mode);
    renameWithRetry(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

export function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

/** Creates the file if missing (content untouched otherwise) and makes it readable by the owner only. */
export function ensurePrivateFile(path: string): void {
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}

const RENAME_HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_TRIES = 5;

/**
 * rename() that, on Windows, waits out a file held for a moment by an indexer or antivirus (up to 5 tries over
 * ~250 ms; a rename over an open file fails there). macOS: one plain rename, as before.
 */
export function renameWithRetry(from: string, to: string, rename: (from: string, to: string) => void = renameSync, sleep: (ms: number) => void = sleepSync): void {
  if (pathStyle() !== 'win32') { rename(from, to); return; }
  for (let i = 1; ; i++) {
    try { rename(from, to); return; } catch (e) {
      if (i >= RENAME_TRIES || !RENAME_HELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      sleep(i * 25);
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
