// Redis values made readable: a string's bytes classified as an integer, JSON, PHP serialize(),
// msgpack, text or binary, and decoded to a JSON-like tree the renderer folds. Pure; gzip is inflated by main first.

export type StringFormat = 'int' | 'json' | 'php' | 'msgpack' | 'text' | 'binary';
export interface Classified { format: StringFormat; text?: string; value?: unknown; hex?: string[] }

const MAX_DEPTH = 64;

// —— PHP serialize() ——

/** PHP's serialize() output as a JSON-like value; undefined when the bytes are not exactly one serialized value. */
export function unserializePhp(b: Uint8Array): unknown {
  if (!b.length || !/^[aObsidNCEr]/.test(String.fromCharCode(b[0]!))) return undefined;
  let i = 0;
  const dec = new TextDecoder('utf-8', { fatal: false });
  const fail = (): never => { throw new Error('php'); };
  const until = (ch: string): string => {
    const code = ch.charCodeAt(0);
    const start = i;
    while (i < b.length && b[i] !== code) i++;
    if (i >= b.length) fail();
    const s = dec.decode(b.subarray(start, i));
    i++;
    return s;
  };
  const expect = (ch: string) => { if (b[i] !== ch.charCodeAt(0)) fail(); i++; };
  const int = (end: string) => { const s = until(end); if (!/^-?\d+$/.test(s)) fail(); return Number(s); };
  const str = (): string => {
    const len = int(':');
    expect('"');
    if (i + len > b.length) fail();
    const s = dec.decode(b.subarray(i, i + len));
    i += len;
    expect('"');
    return s;
  };
  const prop = (k: unknown) => (typeof k === 'string' ? k.replace(/^\0[^\0]*\0/, '') : String(k));
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail();
    const t = String.fromCharCode(b[i] ?? 0);
    i++;
    if (t === 'N') { expect(';'); return null; }
    expect(':');
    switch (t) {
      case 'b': { const v = int(';'); return v === 1; }
      case 'i': return int(';');
      case 'd': { const s = until(';'); const v = Number(s === 'INF' ? Infinity : s === '-INF' ? -Infinity : s); if (Number.isNaN(v) && s !== 'NAN') fail(); return v; }
      case 's': { const s = str(); expect(';'); return s; }
      case 'r': case 'R': int(';'); return '[reference]';
      case 'E': { const s = str(); expect(';'); return { __enum: s }; }
      case 'a': {
        const n = int(':');
        expect('{');
        const entries: [unknown, unknown][] = [];
        for (let k = 0; k < n; k++) entries.push([value(depth + 1), value(depth + 1)]);
        expect('}');
        const list = entries.every(([k], idx) => k === idx);
        return list ? entries.map(([, v]) => v) : Object.fromEntries(entries.map(([k, v]) => [prop(k), v]));
      }
      case 'O': {
        const cls = str();
        expect(':');
        const n = int(':');
        expect('{');
        const o: Record<string, unknown> = { __class: cls };
        for (let k = 0; k < n; k++) { const key = value(depth + 1); o[prop(key)] = value(depth + 1); }
        expect('}');
        return o;
      }
      case 'C': {
        const cls = str();
        expect(':');
        const len = int(':');
        expect('{');
        if (i + len > b.length) fail();
        const data = dec.decode(b.subarray(i, i + len));
        i += len;
        expect('}');
        return { __class: cls, __data: data };
      }
      default: return fail();
    }
  };
  try {
    const v = value(0);
    return i === b.length ? v : undefined;
  } catch {
    return undefined;
  }
}

// —— msgpack ——

const hex = (b: Uint8Array, max = 32) => [...b.subarray(0, max)].map((x) => x.toString(16).padStart(2, '0')).join('') + (b.length > max ? '…' : '');

/** One msgpack value covering all the bytes, as a JSON-like value; undefined otherwise. */
export function decodeMsgpack(b: Uint8Array): unknown {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const dec = new TextDecoder('utf-8', { fatal: true });
  const need = (n: number) => { if (i + n > b.length) throw new Error('short'); };
  const u8 = () => { need(1); return b[i++]!; };
  const u16 = () => { need(2); const x = v.getUint16(i); i += 2; return x; };
  const u32 = () => { need(4); const x = v.getUint32(i); i += 4; return x; };
  const raw = (n: number) => { need(n); const x = b.subarray(i, i + n); i += n; return x; };
  const str = (n: number) => dec.decode(raw(n));
  const big = (x: bigint) => (x <= BigInt(Number.MAX_SAFE_INTEGER) && x >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(x) : x.toString());
  const read = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Error('deep');
    const t = u8();
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 0x100;
    if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f, depth);
    if (t >= 0x90 && t <= 0x9f) return arr(t & 0x0f, depth);
    if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: case 0xc5: case 0xc6: { const n = t === 0xc4 ? u8() : t === 0xc5 ? u16() : u32(); const d = raw(n); return `<bin ${n} bytes: ${hex(d)}>`; }
      case 0xc7: case 0xc8: case 0xc9: { const n = t === 0xc7 ? u8() : t === 0xc8 ? u16() : u32(); const type = u8(); return `<ext ${type}: ${hex(raw(n))}>`; }
      case 0xca: { need(4); const x = v.getFloat32(i); i += 4; return x; }
      case 0xcb: { need(8); const x = v.getFloat64(i); i += 8; return x; }
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: { need(8); const x = v.getBigUint64(i); i += 8; return big(x); }
      case 0xd0: { need(1); const x = v.getInt8(i); i += 1; return x; }
      case 0xd1: { need(2); const x = v.getInt16(i); i += 2; return x; }
      case 0xd2: { need(4); const x = v.getInt32(i); i += 4; return x; }
      case 0xd3: { need(8); const x = v.getBigInt64(i); i += 8; return big(x); }
      case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: { const n = 1 << (t - 0xd4); const type = u8(); return `<ext ${type}: ${hex(raw(n))}>`; }
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16(), depth);
      case 0xdd: return arr(u32(), depth);
      case 0xde: return map(u16(), depth);
      case 0xdf: return map(u32(), depth);
      default: throw new Error('bad');
    }
  };
  const arr = (n: number, depth: number) => { if (n > b.length) throw new Error('short'); const out: unknown[] = []; for (let k = 0; k < n; k++) out.push(read(depth + 1)); return out; };
  const map = (n: number, depth: number) => {
    if (n > b.length) throw new Error('short');
    const o: Record<string, unknown> = {};
    for (let k = 0; k < n; k++) { const key = read(depth + 1); o[typeof key === 'string' ? key : JSON.stringify(key)] = read(depth + 1); }
    return o;
  };
  try {
    const out = read(0);
    return i === b.length ? out : undefined;
  } catch {
    return undefined;
  }
}

// —— binary ——

export function hexDump(b: Uint8Array, max: number): string[] {
  const out: string[] = [];
  const end = Math.min(b.length, max);
  for (let off = 0; off < end; off += 16) {
    const row = b.subarray(off, Math.min(off + 16, end));
    const hx = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = [...row].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    out.push(`${off.toString(16).padStart(8, '0')}  ${hx}  |${ascii}|`);
  }
  return out;
}

// —— classification ——

/** A string value's bytes (the first `shown` of `total`) as what they most likely are. */
export function classifyString(b: Uint8Array, total: number): Classified {
  const whole = b.length >= total;
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { text = null; }
  if (text !== null) {
    const t = text.trim();
    if (whole && /^-?\d{1,18}$/.test(text)) return { format: 'int', text };
    if (whole && /^[[{]/.test(t)) {
      try { return { format: 'json', value: JSON.parse(t) as unknown, text }; } catch { /* not JSON */ }
    }
    if (whole) {
      const php = unserializePhp(b);
      if (php !== undefined) return { format: 'php', value: php, text };
    }
    if (whole && b.length && (b[0]! & 0xf0) === 0x80) {
      const mp = decodeMsgpack(b);
      if (mp !== undefined && typeof mp === 'object') return { format: 'msgpack', value: mp };
    }
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(text)) return { format: 'text', text };
  }
  if (whole) {
    const php = unserializePhp(b);
    if (php !== undefined) return { format: 'php', value: php };
    const mp = decodeMsgpack(b);
    if (mp !== undefined && mp !== null && typeof mp === 'object') return { format: 'msgpack', value: mp };
  }
  return { format: 'binary', hex: hexDump(b, 4096) };
}
