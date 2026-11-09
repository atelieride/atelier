// JSON read as text, never through JSON.parse (no number ever changes on its way to the screen or a copy): a
// small tokenizer for the grid cell's one-line preview, a check that a text is JSON
// at all, the inspector's lossless tree (numbers kept as their source text, JsonNum) and its masked text
// — numbers stay the digits Postgres printed (12345678901234567890 is not 12345678901234567000). Iterative, so a
// deeply nested value never overflows the stack. Pure; lazy, with the table's chunk.
import { MASK, MASK_COLUMN } from '@shared/pg-format';
import { JsonNum } from '../redis/view';

export type JsonTok = { t: 'p' | 'k' | 's' | 'n' | 'l' | 'fo'; s: string };
type Tok = { k: '{' | '}' | '[' | ']' | ':' | ',' | 'str' | 'num' | 'lit'; start: number; end: number };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ['true', 'false', 'null'];
/** A string or a key longer than this many characters is cut in the preview. */
const STR_MAX = 80;

/** Text that starts an object or an array: what `#>>` prints for one (a JSON column's value may hold one). */
export const looksJsonContainer = (s: string): boolean => /^\s*[[{]/.test(s);

/** At most `max` UTF-16 units and an ellipsis, never half a surrogate pair. */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

function ws(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    i++;
  }
  return i;
}

function tok(s: string, i: number): Tok | null {
  const c = s[i];
  if (c === undefined) return null;
  if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') return { k: c, start: i, end: i + 1 };
  if (c === '"') {
    for (let j = i + 1; j < s.length; j++) {
      const ch = s.charCodeAt(j);
      if (ch === 34) return { k: 'str', start: i, end: j + 1 };
      if (ch === 92) j += s[j + 1] === 'u' ? 5 : 1;
      else if (ch < 0x20) return null;
    }
    return null;
  }
  if (c === '-' || (c >= '0' && c <= '9')) {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    return m ? { k: 'num', start: i, end: i + m[0].length } : null;
  }
  for (const l of LITERALS) if (s.startsWith(l, i)) return { k: 'lit', start: i, end: i + l.length };
  return null;
}

/**
 * One whole value from `start`: where it ends and, for an object or an array, how many members it holds directly.
 * Null when it isn't JSON there. A pushdown walk, no recursion.
 */
function scan(s: string, start: number): { end: number; items: number } | null {
  const stack: string[] = [];
  let i = start;
  let items = 0;
  // What may come next: a value, a key, a colon, or a comma / the container's close; `open`: a container just opened.
  let want: 'value' | 'key' | 'colon' | 'next' = 'value';
  let open = false;
  for (;;) {
    i = ws(s, i);
    const t = tok(s, i);
    if (!t) return null;
    const top = stack[stack.length - 1];
    if (t.k === '}' || t.k === ']') {
      if (!(want === 'next' || open) || (t.k === '}' ? top !== '{' : top !== '[')) return null;
      stack.pop();
      i = t.end;
      open = false;
      if (stack.length === 0) return { end: i, items };
      want = 'next';
      continue;
    }
    open = false;
    if (want === 'colon') {
      if (t.k !== ':') return null;
      want = 'value';
    } else if (want === 'next') {
      if (t.k !== ',') return null;
      want = top === '{' ? 'key' : 'value';
    } else if (want === 'key') {
      if (t.k !== 'str') return null;
      if (stack.length === 1) items++;
      want = 'colon';
    } else {
      if (top === '[' && stack.length === 1) items++;
      if (t.k === '{' || t.k === '[') {
        stack.push(t.k);
        want = t.k === '{' ? 'key' : 'value';
        open = true;
      } else if (t.k === 'str' || t.k === 'num' || t.k === 'lit') {
        if (stack.length === 0) return { end: t.end, items };
        want = 'next';
      } else return null;
    }
    i = t.end;
  }
}

/** Whether a text is one JSON value, whitespace around it allowed. */
export function isJsonText(s: string): boolean {
  const r = scan(s, ws(s, 0));
  return r !== null && ws(s, r.end) === s.length;
}

/**
 * A string's source as the preview shows it: at most STR_MAX characters of it (an escape is one, a surrogate pair —
 * written or escaped — is one), then "…" and the closing quote.
 */
function strText(s: string, t: Tok): string {
  let n = 0;
  let j = t.start + 1;
  const close = t.end - 1;
  while (j < close) {
    if (n === STR_MAX) return `${s.slice(t.start, j)}…"`;
    let next = j + 1;
    if (s.charCodeAt(j) === 92) {
      next = j + (s[j + 1] === 'u' ? 6 : 2);
      // An escaped high surrogate takes its low one along.
      const hex = s[j + 1] === 'u' ? parseInt(s.slice(j + 2, j + 6), 16) : -1;
      if (hex >= 0xd800 && hex <= 0xdbff && s.startsWith('\\u', next)) next += 6;
    } else {
      const ch = s.charCodeAt(j);
      if (ch >= 0xd800 && ch <= 0xdbff) next = j + 2;
    }
    j = next;
    n++;
  }
  return s.slice(t.start, t.end);
}

/**
 * The one-line preview of a JSON text: punctuation, keys, strings, numbers and literals as the
 * JSON navigation colors, the top level's members shown, nested objects and arrays folded as {…} and […N]; cut once
 * about `max` characters are out (", …"), so a 64 KB value builds a few tokens — the rest still read to the end (once
 * per value: Cell caches it). Numbers and strings exactly as written. Null when the text isn't one JSON value (a value
 * cut at 64 KB, junk after it): the cell shows it as text.
 */
export function jsonPreview(s: string, max = 160): JsonTok[] | null {
  const out: JsonTok[] = [];
  let len = 0;
  const push = (t: JsonTok['t'], text: string) => { out.push({ t, s: text }); len += text.length; };
  const leaf = (t: Tok): boolean => {
    if (t.k === 'str') push('s', strText(s, t));
    else if (t.k === 'num') push('n', s.slice(t.start, t.end));
    else if (t.k === 'lit') push('l', s.slice(t.start, t.end));
    else return false;
    return true;
  };
  let i = ws(s, 0);
  const first = tok(s, i);
  if (!first) return null;
  if (first.k !== '{' && first.k !== '[') {
    if (!leaf(first) || ws(s, first.end) !== s.length) return null;
    return out;
  }
  const obj = first.k === '{';
  const close = obj ? '}' : ']';
  push('p', first.k);
  i = first.end;
  for (let n = 0; ; n++) {
    i = ws(s, i);
    let t = tok(s, i);
    if (!t) return null;
    if (t.k === close) {
      if (ws(s, t.end) !== s.length) return null;
      push('p', close);
      return out;
    }
    if (n > 0) {
      if (t.k !== ',') return null;
      i = ws(s, t.end);
      t = tok(s, i);
      if (!t) return null;
      if (len >= max) {
        if (!isJsonText(s)) return null;
        push('p', ', …');
        push('p', close);
        return out;
      }
      push('p', ', ');
    }
    if (obj) {
      if (t.k !== 'str') return null;
      push('k', strText(s, t));
      i = ws(s, t.end);
      const colon = tok(s, i);
      if (!colon || colon.k !== ':') return null;
      push('p', ': ');
      i = ws(s, colon.end);
      t = tok(s, i);
      if (!t) return null;
    }
    if (t.k === '{' || t.k === '[') {
      const r = scan(s, i);
      if (!r) return null;
      push('fo', t.k === '[' ? (r.items > 0 ? `[…${r.items}]` : '[]') : (r.items > 0 ? '{…}' : '{}'));
      i = r.end;
    } else {
      if (!leaf(t)) return null;
      i = t.end;
    }
  }
}

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const HEX4 = /^[0-9a-fA-F]{4}$/;

/** A string token's value, its escapes read (\u escapes one UTF-16 unit each: a pair makes its character); null for a bad one. */
function strOf(s: string, t: Tok): string | null {
  const end = t.end - 1;
  let out = '';
  let from = t.start + 1;
  let i = from;
  while (i < end) {
    if (s.charCodeAt(i) !== 92) { i++; continue; }
    out += s.slice(from, i);
    const e = s[i + 1] ?? '';
    if (e === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (!HEX4.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else {
      const c = Object.prototype.hasOwnProperty.call(ESCAPES, e) ? ESCAPES[e] : undefined;
      if (c === undefined) return null;
      out += c;
      i += 2;
    }
    from = i;
  }
  return out + s.slice(from, end);
}

type Frame = { arr: unknown[] } | { obj: Record<string, unknown>; key: string };

/**
 * A JSON text as a tree the inspector's views draw: objects (no prototype: a "__proto__" key is a key
 * like any other; a repeated key keeps its last value, as JavaScript's own parser), arrays, strings, booleans, null, and every
 * number as a JsonNum holding its source text — never through a double. Undefined when the text isn't one JSON value
 * (a value cut at 64 KB). Iterative, as scan.
 */
export function parseJson(s: string): unknown {
  return parseJsonInfo(s).value;
}

/**
 * parseJson, and whether an object repeated a key (a json column keeps what was stored, duplicates too; the tree keeps
 * the last, as JavaScript's parser: the JSON view says so).
 */
export function parseJsonInfo(s: string): { value: unknown; duplicates: boolean } {
  let duplicates = false;
  const value = parseCore(s, () => { duplicates = true; });
  return { value, duplicates };
}

function parseCore(s: string, onDuplicate: () => void): unknown {
  const stack: Frame[] = [];
  let root: unknown;
  let done = false;
  let i = ws(s, 0);
  // What may come next, as scan; `open`: a container just opened (it may close at once).
  let want: 'value' | 'key' | 'colon' | 'next' = 'value';
  let open = false;
  /** A finished value: into the container it belongs to, or the whole text's. */
  const put = (v: unknown) => {
    const top = stack[stack.length - 1];
    if (!top) { root = v; done = true; } else if ('arr' in top) top.arr.push(v); else top.obj[top.key] = v;
  };
  for (;;) {
    i = ws(s, i);
    if (done) return i === s.length ? root : undefined;
    const t = tok(s, i);
    if (!t) return undefined;
    const top = stack[stack.length - 1];
    i = t.end;
    if (t.k === '}' || t.k === ']') {
      if (!(want === 'next' || open) || !top || (t.k === '}') !== ('obj' in top)) return undefined;
      stack.pop();
      open = false;
      want = 'next';
      put('arr' in top ? top.arr : top.obj);
      continue;
    }
    open = false;
    if (want === 'colon') {
      if (t.k !== ':') return undefined;
      want = 'value';
    } else if (want === 'next') {
      if (t.k !== ',' || !top) return undefined;
      want = 'arr' in top ? 'value' : 'key';
    } else if (want === 'key') {
      const key = t.k === 'str' ? strOf(s, t) : null;
      if (key === null || !top || 'arr' in top) return undefined;
      if (Object.prototype.hasOwnProperty.call(top.obj, key)) onDuplicate();
      top.key = key;
      want = 'colon';
    } else if (t.k === '{' || t.k === '[') {
      stack.push(t.k === '[' ? { arr: [] } : { obj: Object.create(null) as Record<string, unknown>, key: '' });
      want = t.k === '{' ? 'key' : 'value';
      open = true;
    } else if (t.k === 'str') {
      const v = strOf(s, t);
      if (v === null) return undefined;
      put(v);
      want = 'next';
    } else if (t.k === 'num') { put(new JsonNum(s.slice(t.start, t.end))); want = 'next'; }
    else if (t.k === 'lit') { const l = s.slice(t.start, t.end); put(l === 'null' ? null : l === 'true'); want = 'next'; }
    else return undefined;
  }
}

/** A masked value in JSON text: a string of dots. */
const MASKED = JSON.stringify(MASK);

/**
 * Mask values on: the text with every value under a key that `secret` names
 * replaced by "••••••••" — the key's whole subtree; null and "" stay, there is nothing to hide —, everything else
 * exactly as written (numbers, spacing). What the inspector's JSON views draw (through parseJson) and copy. A text
 * that isn't JSON (a value cut at 64 KB) can't be read for its keys: it is masked whole.
 */
export function jsonMaskText(s: string, secret: (key: string) => boolean): string {
  if (!isJsonText(s)) return MASK;
  const stack: string[] = [];
  let out = '';
  let last = 0;
  let i = ws(s, 0);
  // A key comes next: just after { or after a comma in an object (the text is JSON: nothing else to check).
  let key = false;
  for (;;) {
    i = ws(s, i);
    const t = tok(s, i);
    if (!t) break;
    i = t.end;
    if (t.k === '{' || t.k === '[') { stack.push(t.k); key = t.k === '{'; continue; }
    if (t.k === '}' || t.k === ']') { stack.pop(); key = false; continue; }
    if (t.k === ',') { key = stack[stack.length - 1] === '{'; continue; }
    if (!key || t.k !== 'str') continue;
    key = false;
    // A key whose escapes can't be read: hidden all the same (better hidden too many).
    const name = strOf(s, t);
    if (name !== null && !secret(name)) continue;
    // Past the colon: the value.
    const at = ws(s, ws(s, i) + 1);
    const v = tok(s, at)!;
    if ((v.k === 'lit' && s.startsWith('null', at)) || (v.k === 'str' && v.end - v.start === 2)) continue;
    const end = v.k === '{' || v.k === '[' ? scan(s, at)!.end : v.end;
    out += s.slice(last, at) + MASKED;
    last = end;
    i = end;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** A key that names a secret (read on JSON keys as on column names): the one definition. */
export const secretKey = (k: string): boolean => MASK_COLUMN.test(k);

/**
 * A JSON value as Mask values shows it everywhere (the grid's preview, its copies, the inspector): with
 * the mask on, every secret key's value as dots (a text that isn't whole JSON — cut at 64 KB — dots whole); off, as is.
 */
export function maskJson(s: string, masked: boolean): string {
  return masked ? jsonMaskText(s, secretKey) : s;
}
