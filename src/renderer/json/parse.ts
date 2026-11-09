// JSON navigation: a strict JSON / JSONC parser that keeps where every value is (offsets,
// lines) and explains the first error in plain words, with a quick fix when there is an obvious one. Iterative: deep
// nesting never overflows the stack. Runs in the JSON worker; pure.

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface JsonNode {
  type: JsonType;
  /** The member's name, the element's index, null for the root. */
  key: string | number | null;
  /** The value's range. */
  from: number;
  to: number;
  /** Where the entry starts: the name's quote for an object member, the value otherwise. */
  start: number;
  /** 1-based lines of the entry's start and of the value's end. */
  line: number;
  endLine: number;
  /** Scalars: the literal as written. */
  raw?: string;
  /** Scalars: the value (strings decoded). */
  value?: string | number | boolean | null;
  children?: JsonNode[];
}

export interface JsonFix { label: string; from: number; to: number; insert: string }

export interface JsonError {
  from: number;
  to: number;
  /** 1-based line and column of `from`. */
  line: number;
  col: number;
  message: string;
  fix?: JsonFix;
}

export type ParseResult = { ok: true; root: JsonNode; nodes: number } | { ok: false; error: JsonError } | { ok: false; empty: true };

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Fail { constructor(readonly error: JsonError) {} }

interface Frame { node: JsonNode; state: 'start' | 'value' | 'comma'; comma: number }

export function parseJson(text: string, opts: { jsonc: boolean }): ParseResult {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = 0;
  let nodes = 0;

  const lineCol = (pos: number): { line: number; col: number } => {
    // Positions behind the cursor of the scan are counted again (errors only, once).
    let l = 1;
    let s = 0;
    for (let k = 0; k < pos && k < n; k++) if (text.charCodeAt(k) === 10) { l++; s = k + 1; }
    return { line: l, col: pos - s + 1 };
  };
  const fail = (from: number, to: number, message: string, fix?: JsonFix): never => {
    const at = lineCol(from);
    throw new Fail({ from, to, line: at.line, col: at.col, message, ...(fix ? { fix } : {}) });
  };

  /** Whitespace and, in JSONC, comments (in JSON a comment is the error). */
  const skip = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10) { i++; line++; lineStart = i; continue; }
      if (c === 32 || c === 9 || c === 13) { i++; continue; }
      if (c === 47 /* / */ && (text[i + 1] === '/' || text[i + 1] === '*')) {
        const start = i;
        let end: number;
        if (text[i + 1] === '/') {
          end = text.indexOf('\n', i);
          if (end < 0) end = n;
        } else {
          const close = text.indexOf('*/', i + 2);
          if (close < 0) fail(start, n, 'Unterminated comment');
          end = close + 2;
        }
        if (!opts.jsonc) fail(start, end, 'Comments are not allowed in JSON');
        for (let k = i; k < end; k++) if (text.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
        i = end;
        continue;
      }
      break;
    }
  };

  /** A word as written (for "Unexpected True"), at most 20 characters. */
  const word = (at: number): number => {
    let k = at;
    while (k < n && k - at < 20 && /[\w$.+-]/.test(text[k]!)) k++;
    return Math.max(k, at + 1);
  };

  const readString = (): { raw: string; value: string; end: number } => {
    const start = i;
    let k = i + 1;
    let out = '';
    let chunk = k;
    for (;;) {
      if (k >= n || text.charCodeAt(k) === 10) {
        const eol = text.indexOf('\n', start);
        fail(start, eol < 0 ? n : eol, 'Unterminated string');
      }
      const c = text.charCodeAt(k);
      if (c === 34 /* " */) break;
      if (c < 32) fail(k, k + 1, 'Control character in a string');
      if (c === 92 /* \ */) {
        out += text.slice(chunk, k);
        const e = text[k + 1] ?? '';
        if (e === 'u') {
          const hex = text.slice(k + 2, k + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(k, Math.min(n, k + 6), `Invalid escape \\u${hex.replace(/[\n"].*$/s, '')}`);
          out += String.fromCharCode(parseInt(hex, 16));
          k += 6;
        } else if (e in ESCAPES) {
          out += ESCAPES[e];
          k += 2;
        } else {
          fail(k, k + 2, `Invalid escape \\${e}`);
        }
        chunk = k;
        continue;
      }
      k++;
    }
    out += text.slice(chunk, k);
    return { raw: text.slice(start, k + 1), value: out, end: k + 1 };
  };

  /** A scalar at i (the caller skipped whitespace and checked it isn't a bracket). */
  const readScalar = (key: string | number | null, start: number, startLine: number): JsonNode => {
    const c = text[i]!;
    const from = i;
    if (c === '"') {
      const s = readString();
      i = s.end;
      return { type: 'string', key, from, to: i, start, line: startLine, endLine: line, raw: s.raw, value: s.value };
    }
    if (c === "'") fail(i, i + 1, 'Single quotes are not JSON: use double quotes');
    if (/[-+.\d]/.test(c)) {
      let k = i;
      while (k < n && /[\d+\-.eE]/.test(text[k]!)) k++;
      const raw = text.slice(i, k);
      if (!NUMBER.test(raw)) fail(i, k, 'Invalid number');
      i = k;
      return { type: 'number', key, from, to: i, start, line: startLine, endLine: line, raw, value: Number(raw) };
    }
    for (const [lit, type, value] of [['true', 'boolean', true], ['false', 'boolean', false], ['null', 'null', null]] as const) {
      if (text.startsWith(lit, i) && !/[\w$]/.test(text[i + lit.length] ?? '')) {
        i += lit.length;
        return { type, key, from, to: i, start, line: startLine, endLine: line, raw: lit, value };
      }
    }
    if (c === ',' || c === ']' || c === '}' || c === ':') fail(i, i + 1, 'Expected a value');
    const end = word(i);
    return fail(i, end, `Unexpected ${text.slice(i, end)}`);
  };

  const isValueStart = (c: string) => /["'{[\-\d.+tfn]/.test(c);

  try {
    skip();
    if (i >= n) return { ok: false, empty: true };
    const stack: Frame[] = [];
    let root: JsonNode | null = null;
    // The next value to read: its key and where its entry starts (null: none wanted now).
    let want: { key: string | number | null; start: number; line: number } | null = { key: null, start: i, line };

    for (;;) {
      if (want) {
        skip();
        if (i >= n) fail(n, n, 'Unexpected end of file');
        const c = text[i]!;
        const parent = stack.at(-1);
        let node: JsonNode;
        if (!parent && (c === ']' || c === '}')) fail(i, i + 1, `Unexpected ${c}`);
        if (c === '{' || c === '[') {
          node = { type: c === '{' ? 'object' : 'array', key: want.key, from: i, to: i + 1, start: want.start, line: want.line, endLine: line, children: [] };
          i++;
        } else {
          node = readScalar(want.key, want.start, want.line);
        }
        nodes++;
        if (parent) { parent.node.children!.push(node); parent.state = 'value'; } else root = node;
        if (node.children) stack.push({ node, state: 'start', comma: -1 });
        want = null;
        continue;
      }
      const top = stack.at(-1);
      skip();
      if (!top) {
        if (i < n) fail(i, word(i), 'Extra content after the value');
        break;
      }
      const isObj = top.node.type === 'object';
      const close = isObj ? '}' : ']';
      if (i >= n) fail(n, n, 'Unexpected end of file');
      const c = text[i]!;
      if (c === close) {
        if (top.state === 'comma' && !opts.jsonc) fail(top.comma, top.comma + 1, `Trailing comma before ${close}`, { label: 'Remove the comma', from: top.comma, to: top.comma + 1, insert: '' });
        top.node.to = i + 1;
        top.node.endLine = line;
        i++;
        stack.pop();
        continue;
      }
      if (top.state === 'value') {
        if (c === ',') { top.state = 'comma'; top.comma = i; i++; continue; }
        if (isValueStart(c)) {
          const prev = top.node.children!.at(-1)!;
          fail(i, i + 1, 'Missing comma', { label: 'Insert a comma', from: prev.to, to: prev.to, insert: ',' });
        }
        fail(i, word(i), `Unexpected ${text.slice(i, word(i))}`);
      }
      // 'start' or 'comma': an entry.
      if (!isObj) {
        if (c === ',') fail(i, i + 1, 'Expected a value');
        if (c === '}') fail(i, i + 1, 'Unexpected }');
        want = { key: top.node.children!.length, start: i, line };
        continue;
      }
      if (c === "'") fail(i, i + 1, 'Single quotes are not JSON: use double quotes');
      if (c !== '"') {
        if (c === ']') fail(i, i + 1, 'Unexpected ]');
        fail(i, c === ',' ? i + 1 : word(i), 'Expected a property name in double quotes');
      }
      const start = i;
      const startLine = line;
      const k = readString();
      i = k.end;
      skip();
      if (text[i] !== ':') {
        if (i >= n) fail(n, n, 'Unexpected end of file');
        fail(i, i + 1, 'Expected : after the property name');
      }
      i++;
      want = { key: k.value, start, line: startLine };
    }
    return { ok: true, root: root!, nodes };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error };
    throw e;
  }
}

/** The nodes from the root down to the innermost one whose entry contains `pos`. */
export function nodeAt(root: JsonNode, pos: number): JsonNode[] {
  const chain = [root];
  let cur = root;
  for (;;) {
    const kids = cur.children;
    if (!kids?.length) break;
    // The last child starting at or before pos.
    let lo = 0;
    let hi = kids.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid]!.start <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const k = found >= 0 ? kids[found]! : null;
    if (!k || pos > k.to) break;
    chain.push(k);
    cur = k;
  }
  return chain;
}

/** A string node's content (from `raw` when the tree came slimmed from the worker). */
export const stringOf = (n: JsonNode): string => (typeof n.value === 'string' ? n.value : (JSON.parse(n.raw ?? '""') as string));

/** Drops strings' decoded values, which `raw` holds already: a smaller tree to send from the worker. */
export function slimTree(root: JsonNode): void {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'string') delete n.value;
    if (n.children) for (const c of n.children) stack.push(c);
  }
}

/** The node at exactly `path` (null when the path no longer exists: never one of its ancestors). */
export function findNode(root: JsonNode, path: readonly (string | number)[]): JsonNode | null {
  const chain = nodeAtPath(root, path);
  return chain.length === path.length + 1 ? chain.at(-1)! : null;
}

/** The nodes along `path` from the root, as far as they exist. */
export function nodeAtPath(root: JsonNode, path: readonly (string | number)[]): JsonNode[] {
  const chain = [root];
  let cur = root;
  for (const seg of path) {
    const next = cur.children?.find((c) => c.key === seg);
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}
