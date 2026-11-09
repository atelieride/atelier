// JSON navigation: a tolerant scan of a JSON text for the editor — where every object and
// array opens and closes, how many entries it has and where each entry starts — that never fails on broken text, so
// folding and the path at the cursor keep working while the user types. Strings and comments are skipped; pure.

export type Segment = string | number;

export interface ScanContainer {
  kind: 'object' | 'array';
  open: number;
  /** The closing bracket's offset; -1 while unclosed. */
  close: number;
  depth: number;
  /** Index of the parent container, -1 for a top-level one. */
  parent: number;
  /** Its key in the parent (null at the top level). */
  key: Segment | null;
  count: number;
  /** Where each entry starts (a member's name quote, an element's first character) and its key. */
  starts: number[];
  keys: Segment[];
}

export interface Scan { containers: ScanContainer[]; /** The first character of the document's value (-1: none). */ start: number }

const keyOf = (raw: string): string => {
  try { return JSON.parse(raw) as string; } catch { return raw.replace(/^"|"$/g, ''); }
};

export function scanJson(text: string): Scan {
  const n = text.length;
  const containers: ScanContainer[] = [];
  const stack: number[] = [];
  // The top container waits for an entry (after its bracket or a comma).
  let awaiting = false;
  let start = -1;
  let i = 0;
  /** A value or name starts at i: recorded as an entry of the top container when it waits for one. */
  const entry = (at: number, key: Segment | null) => {
    if (start < 0) start = at;
    const top = stack.at(-1);
    if (top === undefined || !awaiting) return;
    const c = containers[top]!;
    c.starts.push(at);
    c.keys.push(c.kind === 'array' ? c.count : key ?? '');
    c.count++;
    awaiting = false;
  };
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9 || ch === 0xfeff) { i++; continue; }
    if (ch === 47 /* / */ && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (ch === 47 && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (ch === 34 /* " */) {
      let k = i + 1;
      while (k < n) {
        const c = text.charCodeAt(k);
        if (c === 92) { k += 2; continue; }
        if (c === 34 || c === 10) break;
        k++;
      }
      const top = stack.at(-1);
      const isName = top !== undefined && containers[top]!.kind === 'object';
      entry(i, isName ? keyOf(text.slice(i, Math.min(k + 1, n))) : null);
      i = text.charCodeAt(k) === 34 ? k + 1 : k;
      continue;
    }
    if (ch === 123 /* { */ || ch === 91 /* [ */) {
      entry(i, null);
      const parent = stack.at(-1) ?? -1;
      const p = parent >= 0 ? containers[parent]! : null;
      containers.push({ kind: ch === 123 ? 'object' : 'array', open: i, close: -1, depth: stack.length, parent, key: p && p.count > 0 ? p.keys[p.count - 1]! : null, count: 0, starts: [], keys: [] });
      stack.push(containers.length - 1);
      awaiting = true;
      i++;
      continue;
    }
    if (ch === 125 /* } */ || ch === 93 /* ] */) {
      const top = stack.at(-1);
      if (top !== undefined && containers[top]!.kind === (ch === 125 ? 'object' : 'array')) {
        containers[top]!.close = i;
        stack.pop();
      }
      awaiting = false;
      i++;
      continue;
    }
    if (ch === 44 /* , */) { if (stack.length) awaiting = true; i++; continue; }
    if (ch === 58 /* : */) { i++; continue; }
    // A number, a literal or garbage: one entry, up to the next structural character.
    entry(i, null);
    while (i < n && !/[\s,:{}[\]"/]/.test(text[i]!)) i++;
  }
  return { containers, start };
}

/** The scan moved through an edit (large documents, until the idle scan): offsets mapped, keys and counts kept. */
export function mapScan(scan: Scan, map: (pos: number) => number): Scan {
  return {
    start: scan.start < 0 ? -1 : map(scan.start),
    containers: scan.containers.map((c) => ({ ...c, open: map(c.open), close: c.close < 0 ? -1 : map(c.close), starts: c.starts.map(map) }))
  };
}

/** Index of the last container opening before `pos` (containers are in order of opening). */
function lastOpenBefore(scan: Scan, pos: number): number {
  const cs = scan.containers;
  let lo = 0;
  let hi = cs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid]!.open < pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

const contains = (c: ScanContainer, pos: number) => c.open < pos && (c.close < 0 || pos <= c.close);

/** The path of what the cursor at `pos` is on, and where that entry starts (null: the whole document). */
export function pathAt(scan: Scan, pos: number): { path: Segment[]; start: number | null } {
  let ci = lastOpenBefore(scan, pos);
  while (ci >= 0 && !contains(scan.containers[ci]!, pos)) ci = scan.containers[ci]!.parent;
  if (ci < 0) return { path: [], start: null };
  const chain: ScanContainer[] = [];
  for (let k = ci; k >= 0; k = scan.containers[k]!.parent) chain.unshift(scan.containers[k]!);
  const path: Segment[] = chain.slice(1).map((c) => c.key ?? '');
  const c = chain.at(-1)!;
  // The last entry starting at or before pos.
  let lo = 0;
  let hi = c.starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c.starts[mid]! <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return { path, start: c.open };
  return { path: [...path, c.keys[found]!], start: c.starts[found]! };
}

/** The fold for a line: the first container opening on it and closing on a later line (from after its bracket). */
export function foldAt(scan: Scan, lineFrom: number, lineTo: number): { from: number; to: number; kind: 'object' | 'array'; count: number } | null {
  const cs = scan.containers;
  let k = lastOpenBefore(scan, lineFrom) + 1;
  for (; k < cs.length && cs[k]!.open <= lineTo; k++) {
    const c = cs[k]!;
    if (c.close > lineTo) return { from: c.open + 1, to: c.close, kind: c.kind, count: c.count };
  }
  return null;
}

/** The containers at a depth (the root is 0). */
export const levelContainers = (scan: Scan, depth: number): ScanContainer[] => scan.containers.filter((c) => c.depth === depth);

/** The container a path names (null: a scalar, or no such path). */
export function containerAt(scan: Scan, path: readonly Segment[]): ScanContainer | null {
  const cs = scan.containers;
  let cur = cs.findIndex((c) => c.depth === 0);
  if (cur < 0) return null;
  for (const seg of path) {
    let next = -1;
    for (let k = cur + 1; k < cs.length && (cs[cur]!.close < 0 || cs[k]!.open < cs[cur]!.close); k++) {
      if (cs[k]!.parent === cur && cs[k]!.key === seg) { next = k; break; }
    }
    if (next < 0) return null;
    cur = next;
  }
  return cs[cur]!;
}

/** Where the entry a path names starts (the document's start for the empty path; null: no such entry). */
export function startOfPath(scan: Scan, path: readonly Segment[]): number | null {
  if (!path.length) return scan.start < 0 ? null : scan.start;
  const parent = containerAt(scan, path.slice(0, -1));
  if (!parent) return null;
  const at = parent.keys.indexOf(path.at(-1)!);
  return at < 0 ? null : parent.starts[at]!;
}

/** The scalar at an entry (after its name and colon for a member): its type, and a string's length. */
export function valueAt(text: string, start: number, member: boolean): { type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'; length?: number } | null {
  let i = start;
  const skip = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  if (member) {
    const end = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i, i + 4096));
    if (!end) return null;
    i += end[0].length;
    skip();
    if (text[i] !== ':') return null;
    i++;
    skip();
  }
  const c = text[i];
  if (c === undefined) return null;
  if (c === '{') return { type: 'object' };
  if (c === '[') return { type: 'array' };
  if (c === '"') {
    const m = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(i));
    // Not closed in this text: a string of unknown length (the caller may look further).
    if (!m) return { type: 'string' };
    try { return { type: 'string', length: (JSON.parse(m[0]) as string).length }; } catch { return { type: 'string', length: m[0].length - 2 }; }
  }
  if (/[-\d]/.test(c)) return { type: 'number' };
  if (text.startsWith('true', i) || text.startsWith('false', i)) return { type: 'boolean' };
  if (text.startsWith('null', i)) return { type: 'null' };
  return null;
}
