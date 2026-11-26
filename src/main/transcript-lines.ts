// A session transcript (JSONL) read incrementally: from where the last read stopped, one complete line at a time. A
// week-long file runs to tens of MB, so the first read goes through it once, in 4 MiB chunks; later ones read only what
// was appended. A line still being written stays in `partial` until its newline arrives, never half-parsed.
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export const READ_CHUNK = 4 * 1024 * 1024;

/**
 * `file` opened to read, never through a symlink in its last component. `noFollow` is the system's O_NOFOLLOW: Node
 * has none on Windows, where an open follows links, so there the path is checked once the file is open: no link, and
 * still the very file the handle holds (a link swapped in before the open, or out after it, is refused). A link
 * refused rejects ELOOP, as O_NOFOLLOW does, a link to nowhere included.
 */
export async function openNoFollow(file: string, noFollow: number = constants.O_NOFOLLOW ?? 0): Promise<FileHandle> {
  const loop = () => Object.assign(new Error('a symbolic link'), { code: 'ELOOP' });
  let fh: FileHandle;
  try {
    fh = await open(file, constants.O_RDONLY | noFollow);
  } catch (e) {
    // A plain open of a link to nowhere says ENOENT: the link itself may be there.
    if (!noFollow && (e as NodeJS.ErrnoException).code === 'ENOENT' && (await lstat(file).catch(() => null))?.isSymbolicLink()) throw loop();
    throw e;
  }
  if (noFollow) return fh;
  try {
    const [held, named] = await Promise.all([fh.stat({ bigint: true }), lstat(file, { bigint: true })]);
    if (named.isSymbolicLink() || named.ino !== held.ino || named.dev !== held.dev) throw loop();
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** Where a read stopped: the byte offset after the last whole line's end, the file size seen, and the unfinished line. */
export interface LineCursor { offset: number; size: number; partial: string }

/** How many bytes of `b` end on a whole UTF-8 character (a character cut by the writer is read again next time). */
function wholeChars(b: Buffer): number {
  for (let i = b.length - 1; i >= 0 && i >= b.length - 4; i--) {
    const c = b[i]!;
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    return b.length - i >= need ? b.length : i;
  }
  return b.length;
}

/**
 * Every complete line of `file` from `from` on, parsed as JSON and handed to `take` in order (lines that don't parse
 * are skipped). `from` null, or a file now shorter than `from.offset`, reads from the start. `onStart(fromStart)` runs
 * once, before the first line, so a caller can reset what it built from the old lines. `onChunk` runs after each
 * chunk's lines. Never through a symlink; a missing file or a non-regular one rejects. The cursor given is left as it
 * was: the caller keeps the one returned, whose `offset` stops before a UTF-8 character cut by the writer.
 */
export async function readJsonLines(
  file: string,
  from: LineCursor | null,
  take: (line: unknown) => void,
  onChunk?: () => void,
  onStart?: (fromStart: boolean) => void,
): Promise<LineCursor & { fromStart: boolean }> {
  const fh = await openNoFollow(file);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    const resume = from && st.size >= from.offset ? from : null;
    onStart?.(!resume);
    let pos = resume ? resume.offset : 0;
    const parts: Buffer[] = resume?.partial ? [Buffer.from(resume.partial, 'utf8')] : [];
    const feed = (text: string) => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let v: unknown;
        try { v = JSON.parse(line); } catch { continue; }
        take(v);
      }
      onChunk?.();
    };
    if (pos < st.size) {
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - pos));
      while (pos < st.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const data = buf.subarray(0, bytesRead);
        const nl = data.lastIndexOf(10);
        // A line longer than a chunk (an inline screenshot) builds up until its newline.
        if (nl < 0) { parts.push(Buffer.from(data)); continue; }
        parts.push(data.subarray(0, nl));
        feed(Buffer.concat(parts).toString('utf8'));
        parts.length = 0;
        parts.push(Buffer.from(data.subarray(nl + 1)));
      }
    }
    const rest = Buffer.concat(parts);
    const whole = wholeChars(rest);
    return { offset: pos - (rest.length - whole), size: st.size, partial: rest.subarray(0, whole).toString('utf8'), fromStart: !resume };
  } finally {
    await fh.close();
  }
}
