// The log stream of a container without a TTY is multiplexed (Engine API, "Attach to a container"): each frame is an
// 8-byte header — stream (0 stdin, 1 stdout, 2 stderr), three zero bytes, the body's length big-endian — then the
// body. Bodies are passed on as they arrive (never buffered whole: a declared length can't make us hold gigabytes).
import { StringDecoder } from 'node:string_decoder';

export interface Frame { err: boolean; data: Buffer }

export class Demuxer {
  private head = Buffer.alloc(0);
  private left = 0;
  private stream = 0;

  push(chunk: Buffer): Frame[] {
    const out: Frame[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.left === 0) {
        const need = 8 - this.head.length;
        this.head = Buffer.concat([this.head, chunk.subarray(i, i + need)]);
        i += Math.min(need, chunk.length - i);
        if (this.head.length < 8) break;
        this.stream = this.head[0]!;
        this.left = this.head.readUInt32BE(4);
        this.head = Buffer.alloc(0);
        continue;
      }
      const take = Math.min(this.left, chunk.length - i);
      const data = chunk.subarray(i, i + take);
      i += take;
      this.left -= take;
      if ((this.stream === 1 || this.stream === 2) && data.length) out.push({ err: this.stream === 2, data });
    }
    return out;
  }

  /** Bytes held back (a partial header). */
  buffered(): number { return this.head.length; }
}

export const MAX_LINE = 64 * 1024;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) /;

/**
 * Bytes to lines: UTF-8 across chunks, `\r\n`, a `\r` rewrite (progress bars) keeps the last version, a line longer
 * than MAX_LINE is cut with "…" and the rest of it dropped.
 */
export class LineSplitter {
  private decoder = new StringDecoder('utf8');
  private cur = '';
  private cut = false;

  push(chunk: Buffer): string[] {
    return this.take(this.decoder.write(chunk));
  }

  flush(): string[] {
    const out = this.take(this.decoder.end());
    if (this.cur || this.cut) out.push(this.finish());
    return out;
  }

  private take(text: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', from)) {
      this.add(text.slice(from, nl));
      out.push(this.finish());
      from = nl + 1;
    }
    this.add(text.slice(from));
    return out;
  }

  private add(part: string): void {
    if (this.cut || !part) return;
    this.cur += part;
    if (this.cur.length > MAX_LINE + 1) { this.cur = this.cur.slice(0, MAX_LINE); this.cut = true; }
  }

  private finish(): string {
    let line = this.cut ? `${this.cur}…` : this.cur.replace(/\r$/, '');
    // A progress line rewritten with \r: its last version, under Docker's timestamp (only the first one carries it).
    if (!this.cut && line.includes('\r')) line = (STAMP.exec(line)?.[0] ?? '') + line.slice(line.lastIndexOf('\r') + 1);
    this.cur = '';
    this.cut = false;
    return line;
  }
}
