// JSON navigation: the tree's visible rows — what is open, what the filter keeps and
// highlights, big containers in chunks — from a parsed document. Iterative (deep documents never overflow); pure.
import { stringOf, type JsonNode } from './parse';
import type { Segment } from './scan';
import { groupNumber, segLabel } from './paths';

/** [from, to) inside the shown text. */
export type Hit = [number, number];

export interface NodeRow {
  kind: 'node';
  id: string;
  node: JsonNode;
  key: Segment | null;
  path: Segment[];
  depth: number;
  /** The row it sits under (its container or chunk); null at the top. */
  parent: string | null;
  box: boolean;
  open: boolean;
  /** Containers: "{3}" / "[4]". */
  chip: string;
  /** Closed containers: the first entries in one line; null when open. */
  preview: string | null;
  /** Scalars: the literal, cut at 300 characters. */
  value: string | null;
  line: number;
  /** Shown only because something inside matches the filter. */
  miss: boolean;
  keyHits: Hit[];
  valueHits: Hit[];
}

export interface ChunkRow {
  kind: 'chunk';
  id: string;
  /** The container's path. */
  path: Segment[];
  depth: number;
  parent: string | null;
  /** Entry positions, inclusive. */
  from: number;
  to: number;
  open: boolean;
  label: string;
  preview: string;
}

export type Row = NodeRow | ChunkRow;

const CHUNK = 100;
const MAX_VALUE = 300;

export const pathKey = (path: readonly Segment[]): string => JSON.stringify(path);
// Chunk ids start with "#", which no path key (a JSON array) does: keys containing "#" stay nodes.
const chunkId = (path: readonly Segment[], size: number, from: number) => `#${size}:${from}@${pathKey(path)}`;

/** A node row's path from its id; null for a chunk. */
export const rowPath = (id: string): Segment[] | null => (id.startsWith('#') ? null : (JSON.parse(id) as Segment[]));

/** Entries per chunk for a range of `n` entries (0: no chunks): 100, 10 000…, so no level has over 100 rows. */
export function chunkSize(n: number): number {
  if (n <= CHUNK) return 0;
  let size = CHUNK;
  while (Math.ceil(n / size) > CHUNK) size *= CHUNK;
  return size;
}

/** A value in one short piece for previews. */
function short(n: JsonNode): string {
  if (n.children) return n.children.length ? (n.type === 'object' ? '{…}' : '[…]') : n.type === 'object' ? '{}' : '[]';
  if (n.type === 'string') {
    const s = stringOf(n);
    return JSON.stringify(s.length > 22 ? `${s.slice(0, 19)}…` : s);
  }
  return n.raw ?? String(n.value);
}

export function preview(n: JsonNode): string {
  const kids = n.children ?? [];
  const head = kids.slice(0, 4).map((c) => (n.type === 'object' ? `${segLabel(c.key as string)}: ${short(c)}` : short(c)));
  return head.join(', ') + (kids.length > 4 ? ', …' : '');
}

export const chipOf = (n: JsonNode) => (n.type === 'object' ? `{${groupNumber(n.children!.length)}}` : `[${groupNumber(n.children!.length)}]`);

function hits(text: string, q: string): Hit[] {
  if (!q) return [];
  const out: Hit[] = [];
  const low = text.toLowerCase();
  // Lower-casing that changes the length (İ) would shift the offsets: no highlight rather than a wrong one.
  if (low.length !== text.length) return out;
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) out.push([at, at + q.length]);
  return out;
}

const shownValue = (n: JsonNode) => {
  const raw = n.raw ?? '';
  return raw.length > MAX_VALUE ? `${raw.slice(0, MAX_VALUE)}…` : raw;
};

/** Nodes that match the filter themselves, and nodes with a match inside. */
function matchSets(root: JsonNode, q: string): { self: Set<JsonNode>; inside: Set<JsonNode> } {
  const self = new Set<JsonNode>();
  const inside = new Set<JsonNode>();
  // Post-order without recursion: a node is settled after its children.
  const stack: { n: JsonNode; parent: JsonNode | null; done: boolean }[] = [{ n: root, parent: null, done: false }];
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (!top.done && top.n.children?.length) {
      top.done = true;
      for (let k = top.n.children.length - 1; k >= 0; k--) stack.push({ n: top.n.children[k]!, parent: top.n, done: false });
      continue;
    }
    stack.pop();
    const n = top.n;
    const byKey = typeof n.key === 'string' && n.key.toLowerCase().includes(q);
    const byValue = !n.children && (n.raw ?? '').toLowerCase().includes(q);
    if (byKey || byValue) self.add(n);
    if (top.parent && (self.has(n) || inside.has(n))) inside.add(top.parent);
  }
  return { self, inside };
}

type Task =
  // all: inside a container that matches the filter itself and that the user opened, every entry shows.
  | { t: 'node'; n: JsonNode; path: Segment[]; depth: number; parent: string | null; all: boolean }
  | { t: 'chunk'; row: ChunkRow; box: JsonNode; all: boolean }
  | { t: 'range'; box: JsonNode; path: Segment[]; from: number; to: number; depth: number; parent: string | null; all: boolean };

/** The rows to show: the root's entries (or a scalar root), open containers' children, chunks. */
export function buildRows(root: JsonNode, opts: { expanded: ReadonlySet<string>; query: string }): { rows: Row[]; matches: number } {
  const q = opts.query.trim().toLowerCase();
  const m = q ? matchSets(root, q) : null;
  const visible = (n: JsonNode) => !m || m.self.has(n) || m.inside.has(n);
  const rows: Row[] = [];
  const tasks: Task[] = root.children
    ? [{ t: 'range', box: root, path: [], from: 0, to: root.children.length - 1, depth: 0, parent: null, all: false }]
    : visible(root) ? [{ t: 'node', n: root, path: [], depth: 0, parent: null, all: false }] : [];

  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.t === 'range') {
      const { box, path, from, to, depth, parent, all } = task;
      const kids = box.children!;
      const size = chunkSize(to - from + 1);
      const next: Task[] = [];
      if (!size) {
        for (let k = from; k <= to; k++) {
          const c = kids[k]!;
          if (all || visible(c)) next.push({ t: 'node', n: c, path: [...path, c.key as Segment], depth, parent, all });
        }
      } else {
        const end = (c: JsonNode) => (box.type === 'object' ? segLabel(c.key as string) : short(c));
        for (let a = from; a <= to; a += size) {
          const b = Math.min(to, a + size - 1);
          if (m && !all && !kids.slice(a, b + 1).some(visible)) continue;
          const id = chunkId(path, size, a);
          next.push({ t: 'chunk', box, all, row: {
            kind: 'chunk', id, path, depth, parent, from: a, to: b, open: m && !all ? true : opts.expanded.has(id),
            label: `${groupNumber(a)} … ${groupNumber(b)}`, preview: `${end(kids[a]!)} … ${end(kids[b]!)}`
          } });
        }
      }
      for (let k = next.length - 1; k >= 0; k--) tasks.push(next[k]!);
      continue;
    }
    if (task.t === 'chunk') {
      const r = task.row;
      rows.push(r);
      if (r.open) tasks.push({ t: 'range', box: task.box, path: r.path, from: r.from, to: r.to, depth: r.depth + 1, parent: r.id, all: task.all });
      continue;
    }
    const { n, path, depth, parent, all } = task;
    const box = !!n.children;
    const id = pathKey(path);
    // Filtering: a container with matches inside opens; one that only matches itself keeps the user's choice.
    const open = box && (m && !all ? m.inside.has(n) || opts.expanded.has(id) : opts.expanded.has(id));
    const value = box ? null : shownValue(n);
    rows.push({
      kind: 'node', id, node: n, key: n.key, path, depth, parent, box, open,
      chip: box ? chipOf(n) : '', preview: box && !open ? preview(n) : null, value, line: n.line,
      miss: !!m && !all && !m.self.has(n),
      keyHits: m && typeof n.key === 'string' ? hits(n.key, q) : [],
      valueHits: m && value !== null ? hits(value, q) : []
    });
    if (open && n.children!.length) tasks.push({ t: 'range', box: n, path, from: 0, to: n.children!.length - 1, depth: depth + 1, parent: id, all: all || (!!m && m.self.has(n) && !m.inside.has(n)) });
  }
  return { rows, matches: m ? m.self.size : 0 };
}

/** Every container below the root (and its chunks), in document order. */
function walkBoxes(root: JsonNode, fn: (n: JsonNode, path: Segment[]) => void) {
  const stack: { n: JsonNode; path: Segment[] }[] = [{ n: root, path: [] }];
  while (stack.length) {
    const { n, path } = stack.pop()!;
    if (!n.children) continue;
    if (path.length) fn(n, path);
    for (let k = n.children.length - 1; k >= 0; k--) {
      const c = n.children[k]!;
      if (c.children) stack.push({ n: c, path: [...path, c.key as Segment] });
    }
  }
}

/** The chunk ids of a container (every level). */
function chunkIds(n: JsonNode, path: readonly Segment[]): string[] {
  const out: string[] = [];
  const ranges: [number, number][] = [[0, (n.children?.length ?? 0) - 1]];
  while (ranges.length) {
    const [from, to] = ranges.pop()!;
    const size = chunkSize(to - from + 1);
    if (!size) continue;
    for (let a = from; a <= to; a += size) {
      out.push(chunkId(path, size, a));
      ranges.push([a, Math.min(to, a + size - 1)]);
    }
  }
  return out;
}

/** What opens first: small documents (under 200 values) the first two levels, others nothing. */
export function initialExpanded(root: JsonNode, nodes: number): Set<string> {
  const out = new Set<string>();
  if (nodes >= 200) return out;
  walkBoxes(root, (_, path) => { if (path.length <= 2) out.add(pathKey(path)); });
  return out;
}

/** Expand all: every container and chunk. */
export function allIds(root: JsonNode): string[] {
  const out = chunkIds(root, []);
  walkBoxes(root, (n, path) => { out.push(pathKey(path), ...chunkIds(n, path)); });
  return out;
}

/** A container and everything inside it (Expand Children, ⌥→, ⌥-click). */
export function subtreeIds(root: JsonNode, path: readonly Segment[]): string[] {
  let n: JsonNode | undefined = root;
  for (const seg of path) n = n?.children?.find((c) => c.key === seg);
  if (!n?.children) return [];
  const out = [pathKey(path), ...chunkIds(n, path)];
  walkBoxes(n, (c, rel) => { const p = [...path, ...rel]; out.push(pathKey(p), ...chunkIds(c, p)); });
  return out;
}

/** The ids to open so the value at `path` shows: its ancestors and the chunks on the way. */
export function revealIds(root: JsonNode, path: readonly Segment[]): string[] {
  const out: string[] = [];
  let n: JsonNode = root;
  for (let d = 0; d < path.length; d++) {
    const kids = n.children;
    if (!kids) break;
    const at = kids.findIndex((c) => c.key === path[d]);
    if (at < 0) break;
    const here = path.slice(0, d);
    if (d > 0) out.push(pathKey(here));
    let from = 0;
    let to = kids.length - 1;
    for (let size = chunkSize(to - from + 1); size; size = chunkSize(to - from + 1)) {
      const a = from + Math.floor((at - from) / size) * size;
      out.push(chunkId(here, size, a));
      from = a;
      to = Math.min(to, a + size - 1);
    }
    n = kids[at]!;
  }
  return out;
}
