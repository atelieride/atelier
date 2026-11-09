// RESP2, the Redis wire protocol: commands out as arrays of bulk strings, replies in through a
// streaming parser that copes with frames split anywhere. Bulk strings stay Buffers (values can be binary); callers
// turn them into text where they expect text.

export class RespError {
  constructor(readonly message: string) {}
}
export class ReplyTooLarge extends Error { constructor() { super('Redis reply too large'); } }
export class ProtocolError extends Error { constructor() { super('Redis protocol error'); } }

export type Reply = string | number | Buffer | null | RespError | Reply[];
export type Arg = string | number | Buffer;

export function encodeCommand(args: readonly Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** A reply as text: bulk strings decoded as UTF-8, simple strings and integers as they are; anything else ''. */
export function text(r: Reply): string {
  if (Buffer.isBuffer(r)) return r.toString('utf8');
  if (typeof r === 'string') return r;
  if (typeof r === 'number') return String(r);
  return '';
}

const INCOMPLETE = Symbol('incomplete');
type Parsed = { value: Reply; end: number } | typeof INCOMPLETE;

export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  /** Chunks waiting until the buffer can hold what a bulk string announced (no copy, no re-parse per chunk). */
  private parts: Buffer[] = [];
  private size = 0;
  private want = 0;

  /** `max`: the largest reply accepted, in bytes (a bigger one throws ReplyTooLarge). */
  constructor(private readonly max = 16 * 1024 * 1024) {}

  push(chunk: Buffer): Reply[] {
    this.size += chunk.length;
    if (this.size < this.want) {
      this.parts.push(chunk);
      if (this.size > this.max) throw new ReplyTooLarge();
      return [];
    }
    this.buf = this.parts.length || this.buf.length ? Buffer.concat([this.buf, ...this.parts, chunk]) : chunk;
    this.parts = [];
    this.want = 0;
    const out: Reply[] = [];
    let at = 0;
    for (;;) {
      if (at >= this.buf.length) break;
      const r = this.parse(at);
      if (r === INCOMPLETE) break;
      out.push(r.value);
      at = r.end;
    }
    this.buf = at >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(at);
    this.size = this.buf.length;
    // `want` was set relative to where the last parse started: re-based on what is kept.
    this.want = this.want > at ? this.want - at : 0;
    if (this.buf.length > this.max) throw new ReplyTooLarge();
    return out;
  }

  private line(at: number): { text: string; end: number } | typeof INCOMPLETE {
    const nl = this.buf.indexOf('\r\n', at, 'latin1');
    if (nl < 0) {
      if (this.buf.length - at > this.max) throw new ReplyTooLarge();
      return INCOMPLETE;
    }
    return { text: this.buf.toString('utf8', at, nl), end: nl + 2 };
  }

  private parse(at: number): Parsed {
    const type = this.buf[at];
    const l = this.line(at + 1);
    if (l === INCOMPLETE) return INCOMPLETE;
    switch (type) {
      case 0x2b: return { value: l.text, end: l.end }; // +
      case 0x2d: return { value: new RespError(l.text), end: l.end }; // -
      case 0x3a: { // :
        const n = Number(l.text);
        if (!Number.isFinite(n)) throw new ProtocolError();
        return { value: n, end: l.end };
      }
      case 0x24: { // $
        const len = Number(l.text);
        if (!Number.isInteger(len) || len < -1) throw new ProtocolError();
        if (len === -1) return { value: null, end: l.end };
        if (len > this.max) throw new ReplyTooLarge();
        if (this.buf.length < l.end + len + 2) { this.want = Math.max(this.want, l.end + len + 2); return INCOMPLETE; }
        return { value: this.buf.subarray(l.end, l.end + len), end: l.end + len + 2 };
      }
      case 0x2a: { // *
        const n = Number(l.text);
        if (!Number.isInteger(n) || n < -1) throw new ProtocolError();
        if (n === -1) return { value: null, end: l.end };
        const items: Reply[] = [];
        let end = l.end;
        for (let i = 0; i < n; i++) {
          if (end >= this.buf.length) return INCOMPLETE;
          const r = this.parse(end);
          if (r === INCOMPLETE) return INCOMPLETE;
          items.push(r.value);
          end = r.end;
        }
        return { value: items, end };
      }
      default: throw new ProtocolError();
    }
  }
}
