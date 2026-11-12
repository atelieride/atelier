import { isUtf8 } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { isGitDirName, isInside, splitPath } from '@shared/paths';
import type { SearchLine } from '@shared/search';
import { lineResult } from '@shared/search-match';
import { looksBinary, utf16Text } from '../fs/files';

export interface ScanLimits {
  /** Files up to this size are read whole. */
  wholeReadBytes: number;
  /** Files up to this size are read as a stream; larger ones are skipped. */
  maxBytes: number;
  /** Characters of a matching line that are kept. */
  keptLineChars: number;
  /** Bytes per chunk of a streamed read (tests make it tiny to cross boundaries). */
  chunkBytes?: number;
}

export type ScanResult =
  | { kind: 'lines'; size: number; lines: SearchLine[]; count: number; truncated: boolean }
  | { kind: 'none' }
  | { kind: 'binary' }
  | { kind: 'skipped'; size: number; reason: 'too-large' | 'unreadable' };

type Ranges = (line: string) => [number, number][];

/** Matches found so far in one file, within the search's remaining budget. */
class Collector {
  readonly lines: SearchLine[] = [];
  count = 0;
  truncated = false;
  private lineNo = 0;

  constructor(
    private readonly ranges: Ranges,
    private readonly keptLineChars: number,
    private readonly budget: number,
  ) {}

  get done(): boolean {
    return this.truncated;
  }

  /** One line of text (without its line break); false once the budget is spent. */
  push(raw: string): boolean {
    this.lineNo++;
    if (this.truncated) return false;
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let found = this.ranges(text);
    if (found.length === 0) return true;
    const room = this.budget - this.count;
    if (room <= 0) {
      this.truncated = true;
      return false;
    }
    if (found.length > room) {
      found = found.slice(0, room);
      this.truncated = true;
    }
    this.count += found.length;
    this.lines.push(lineResult(this.lineNo, text, found, this.keptLineChars));
    return !this.truncated;
  }
}

/** Lines of a decoded text: split on `\n`; a final empty piece after a trailing `\n` is no line. */
function pushText(c: Collector, text: string, cancelled: () => boolean): boolean {
  let from = 0;
  let n = 0;
  while (from <= text.length) {
    const nl = text.indexOf('\n', from);
    if (nl < 0) {
      if (from < text.length) c.push(text.slice(from));
      return true;
    }
    if (!c.push(text.slice(from, nl))) return false;
    from = nl + 1;
    if ((++n & 1023) === 0 && cancelled()) return false;
  }
  return true;
}

type Decoding = 'utf8' | 'latin1' | 'utf16le' | 'utf16be';

interface Piece { decode(chunk: Buffer): string; end(): string }

function decoderFor(d: Decoding): Piece {
  if (d === 'latin1') {
    const s = new StringDecoder('latin1');
    return { decode: (b) => s.write(b), end: () => s.end() };
  }
  // A UTF-8 byte order mark is a character the editor shows too: keep it so columns agree (the caller skips UTF-16's).
  const t = new TextDecoder(d === 'utf8' ? 'utf-8' : d === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: d === 'utf8', ignoreBOM: true });
  return { decode: (b) => t.decode(b, { stream: true }), end: () => t.decode() };
}

/**
 * Reads a file in chunks, line by line; 'decode-error' when strict UTF-8 fails, 'cancelled' when asked to stop.
 * The unfinished line is kept as pieces and joined once when its newline arrives, and a newline is looked for only
 * in the newly decoded piece: a minified one-line file costs its own size, not a copy per chunk. When the budget
 * runs out the read stops there, so a later byte that would have made the whole read Latin-1 is never seen.
 * Matching one giant line cannot be interrupted by `cancelled()`: the caller's watchdog covers it.
 */
async function streamLines(path: string, decoding: Decoding, skip: number, chunkBytes: number, c: Collector, cancelled: () => boolean): Promise<'ok' | 'decode-error' | 'cancelled'> {
  const dec = decoderFor(decoding);
  const wide = decoding === 'utf16le' || decoding === 'utf16be';
  const stream = createReadStream(path, { start: skip, highWaterMark: chunkBytes });
  let pieces: string[] = [];
  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const raw of stream) {
      if (cancelled()) return 'cancelled';
      let buf = carry.length ? Buffer.concat([carry, raw as Buffer]) : (raw as Buffer);
      carry = Buffer.alloc(0);
      if (wide && buf.length % 2 === 1) {
        // A UTF-16 unit split across chunks waits for its second byte; one left at the very end is dropped, as the whole read does.
        carry = Buffer.from(buf.subarray(buf.length - 1));
        buf = buf.subarray(0, buf.length - 1);
      }
      let text: string;
      try {
        text = dec.decode(buf);
      } catch {
        return 'decode-error';
      }
      const cut = text.lastIndexOf('\n');
      if (cut < 0) {
        if (text) pieces.push(text);
        continue;
      }
      pieces.push(text.slice(0, cut + 1));
      const done = pieces.join('');
      pieces = cut + 1 < text.length ? [text.slice(cut + 1)] : [];
      if (!pushText(c, done, cancelled)) return cancelled() ? 'cancelled' : 'ok';
    }
    let tail: string;
    try {
      tail = pieces.join('') + dec.end();
    } catch {
      return 'decode-error';
    }
    if (tail) c.push(tail);
    return 'ok';
  } finally {
    stream.destroy();
  }
}

async function head(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Searches one file the way the editor would show it (UTF-8, UTF-16 with a byte order mark, else Latin-1).
 * The file's real path must stay inside `realRoot` and outside `.git`; anything else, a deleted file or a
 * non-regular file is `none`. A cancelled scan is `none` too.
 */
export async function scanFile(path: string, ranges: Ranges, limits: ScanLimits, budget: number, cancelled: () => boolean, realRoot: string): Promise<ScanResult> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'skipped', size: 0, reason: 'unreadable' };
  }
  if (!isInside(realRoot, real)) return { kind: 'none' };
  if (splitPath(real.slice(realRoot.length)).some((seg) => isGitDirName(seg))) return { kind: 'none' };

  let size: number;
  try {
    const st = await stat(real);
    if (!st.isFile()) return { kind: 'none' };
    size = st.size;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'skipped', size: 0, reason: 'unreadable' };
  }
  try {
    // Binary first: a large video is a binary file, not a text too large to show.
    if (looksBinary(real)) return { kind: 'binary' };
    if (size > limits.maxBytes) return { kind: 'skipped', size, reason: 'too-large' };
    if (cancelled()) return { kind: 'none' };
    const c = new Collector(ranges, limits.keptLineChars, budget);
    const chunk = limits.chunkBytes ?? 256 * 1024;

    if (size <= limits.wholeReadBytes) {
      const buf = await readFile(real);
      const text = utf16Text(buf) ?? (isUtf8(buf) ? buf.toString('utf8') : buf.toString('latin1'));
      pushText(c, text, cancelled);
    } else {
      const bom = await head(real);
      const wide = bom[0] === 0xff && bom[1] === 0xfe ? 'utf16le' : bom[0] === 0xfe && bom[1] === 0xff ? 'utf16be' : null;
      let outcome = await streamLines(real, wide ?? 'utf8', wide ? 2 : 0, chunk, c, cancelled);
      if (outcome === 'decode-error') {
        // Not UTF-8: start over as Latin-1, with nothing kept from the first attempt.
        const again = new Collector(ranges, limits.keptLineChars, budget);
        outcome = await streamLines(real, 'latin1', 0, chunk, again, cancelled);
        return outcome === 'cancelled' ? { kind: 'none' } : { kind: 'lines', size, lines: again.lines, count: again.count, truncated: again.truncated };
      }
      if (outcome === 'cancelled') return { kind: 'none' };
    }
    if (cancelled() && !c.done) return { kind: 'none' };
    return { kind: 'lines', size, lines: c.lines, count: c.count, truncated: c.truncated };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'none' } : { kind: 'skipped', size, reason: 'unreadable' };
  }
}
