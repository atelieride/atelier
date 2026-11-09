// The Relations card's and view's layout: this table in the middle,
// the tables it points to on the left (N:1), those pointing at it on the right (1:N), one node per table and side
// whatever the number of keys between them (an edge, labelled with its columns, per key), a self-reference as a loop
// over the middle node. Nodes are evenly spaced on each side, never closer than a node and a gap: a long list grows the
// height (the card scrolls) instead of piling nodes up. The three columns fit the width they are given, never
// overlapping, each as wide as its names need while the width holds them (follow-up 1); only then labels ellipsize
// inside the nodes (structure.css). Pure.
import type { DbFk, DbRelations } from '@shared/databases';

export type RelSide = 'left' | 'center' | 'right';
/** A table on the diagram: `y` its center; `via` the columns of the keys between it and this table. */
export interface RelNode { key: string; schema: string; name: string; side: RelSide; y: number; label: string; via: string[] }
/** A foreign key: from the table holding it to the one it points at (node keys), labelled with its columns. */
export interface RelEdge { from: string; to: string; label: string; self: boolean; fk: DbFk }
export interface RelLayout { nodes: RelNode[]; edges: RelEdge[]; height: number }

/** The card's node height; the Relations view passes its own. */
export const REL_NODE_H = 34;
const REL_GAP = 10;
/** The least distance between two nodes' centers on a side: a node and a gap. */
export const REL_PITCH_MIN = REL_NODE_H + REL_GAP;
/** Room over the middle node for a self-reference's loop; each further one rises this much higher (and wider). */
const LOOP = 28;
const LOOP_STEP = 10;

/** A node's key: its side and its table, each part encoded (a dot or a slash in a name never makes two tables one). */
export function relKey(side: RelSide, schema: string, name: string): string {
  return `${side}:${encodeURIComponent(schema)}/${encodeURIComponent(name)}`;
}

const cols = (fk: DbFk): string => fk.from.columns.join(', ');

/**
 * The nodes and edges for `center`'s relations in a box `height` tall (taller when a side needs it: the returned
 * height). `nodeH`: the nodes' height (the view's are bigger).
 */
export function layoutRelations(center: { schema: string; name: string }, r: DbRelations, height: number, o: { nodeH?: number } = {}): RelLayout {
  const nodeH = o.nodeH ?? REL_NODE_H;
  const pitch = nodeH + REL_GAP;
  const mid = relKey('center', center.schema, center.name);
  const isCenter = (schema: string, table: string) => schema === center.schema && table === center.name;
  const label = (schema: string, name: string) => (schema === center.schema ? name : `${schema}.${name}`);
  const sides = { left: new Map<string, RelNode>(), right: new Map<string, RelNode>() };
  const edges: RelEdge[] = [];
  const nodeOf = (side: 'left' | 'right', schema: string, name: string): RelNode => {
    const key = relKey(side, schema, name);
    let n = sides[side].get(key);
    if (!n) sides[side].set(key, (n = { key, schema, name, side, y: 0, label: label(schema, name), via: [] }));
    return n;
  };
  let self = 0;
  for (const fk of r.out) {
    if (isCenter(fk.to.schema, fk.to.table)) {
      // A self-reference is in both lists (main's DbRelations): one loop, from its `out` side.
      self++;
      edges.push({ from: mid, to: mid, label: cols(fk), self: true, fk });
      continue;
    }
    const n = nodeOf('left', fk.to.schema, fk.to.table);
    if (!n.via.includes(cols(fk))) n.via.push(cols(fk));
    edges.push({ from: mid, to: n.key, label: cols(fk), self: false, fk });
  }
  for (const fk of r.in) {
    if (isCenter(fk.from.schema, fk.from.table)) {
      if (!r.out.some((o) => o.name === fk.name && isCenter(o.from.schema, o.from.table))) {
        self++;
        edges.push({ from: mid, to: mid, label: cols(fk), self: true, fk });
      }
      continue;
    }
    const n = nodeOf('right', fk.from.schema, fk.from.table);
    if (!n.via.includes(cols(fk))) n.via.push(cols(fk));
    edges.push({ from: n.key, to: mid, label: cols(fk), self: false, fk });
  }
  const byLabel = (a: RelNode, b: RelNode) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const left = [...sides.left.values()].sort(byLabel);
  const right = [...sides.right.values()].sort(byLabel);
  // Several loops nest, each higher: the tallest still inside the box.
  const h = Math.max(height, left.length * pitch, right.length * pitch, self ? nodeH + 2 * (LOOP + 4 + LOOP_STEP * (self - 1)) : 0);
  // Evenly over the whole height, each side on its own.
  const place = (list: RelNode[]) => list.forEach((n, i) => { n.y = ((i + 0.5) * h) / list.length; });
  place(left);
  place(right);
  const middle: RelNode = { key: mid, schema: center.schema, name: center.name, side: 'center', y: h / 2, label: center.name, via: [] };
  // Edges in the order the nodes are drawn (left top to bottom, then right), the loop last.
  const order = new Map([...left, ...right].map((n, i) => [n.key, i]));
  const rank = (e: RelEdge) => (e.self ? Number.MAX_SAFE_INTEGER : order.get(e.from === mid ? e.to : e.from) ?? 0);
  edges.sort((a, b) => rank(a) - rank(b));
  return { nodes: [middle, ...left, ...right], edges, height: h };
}

/** The three columns' places: x of each, each column's node width, the gap the edges cross. */
export interface RelColumns { width: number; nodeW: Record<RelSide, number>; gap: number; x: Record<RelSide, number> }

/**
 * What a side's nodes need to show their names whole (RelDiagram measures them): the widest name's text, and what a
 * node adds around it — its padding; on the right, the 1:N mark and its gap. `sub`: the widest second line (the
 * Relations view's keys' columns under the names), whole once every name is.
 */
export interface RelNeed { text: number; chrome: number; sub?: number }

const SIDES: readonly RelSide[] = ['left', 'center', 'right'];
const MIN_NODE_W = 56;
const MIN_GAP = 16;
const MAX_GAP = 120;

const total = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);

/**
 * Widths from `lo` up to `hi` in `room`: `hi` when they all fit, `lo` when not even that does; else one level for all,
 * each `level + off` held between its bounds, in whole pixels — `off` 0 widens the narrowest first, a side's chrome
 * gives every name the same room.
 */
function share(lo: readonly number[], hi: readonly number[], off: readonly number[], room: number): number[] {
  if (total(hi) <= room) return [...hi];
  if (total(lo) >= room) return [...lo];
  const at = (level: number) => lo.map((l, i) => Math.min(hi[i]!, Math.max(l, level + off[i]!)));
  let a = Math.min(...lo.map((l, i) => l - off[i]!));
  let b = Math.max(...hi.map((h, i) => h - off[i]!));
  for (let k = 0; k < 40; k++) {
    const m = (a + b) / 2;
    if (total(at(m)) <= room) a = m;
    else b = m;
  }
  return at(a).map((v) => Math.floor(v));
}

/**
 * The columns for a box `width` wide. Each side's nodes as wide as their names need
 * (`needs`), gaps of ~10% (16–120 px) between the columns. Names that don't fit take the gaps first (down to 16 px),
 * then every cut name keeps the same room — the 1:N mark's on top, never under 56 px a node. Second lines come next,
 * from what the names leave (never the gaps). What is left widens the narrowest nodes first, up to `maxNode` (short
 * names: three equal columns; `maxNode` caps that air, never a name), and the columns are centered. Without
 * `needs` (a markup render), three equal columns. Narrower than three nodes of 56 px fit, the box keeps that width (the
 * card scrolls sideways): labels ellipsize inside nodes, never overlap.
 */
export function relationsGeometry(width: number, o: { maxNode?: number; needs?: Record<RelSide, RelNeed> | undefined } = {}): RelColumns {
  const maxNode = o.maxNode ?? 200;
  const w = Math.max(Math.floor(width), 3 * MIN_NODE_W + 2 * MIN_GAP);
  const chrome = SIDES.map((s) => o.needs?.[s].chrome ?? 0);
  const want = SIDES.map((s, i) => Math.max(MIN_NODE_W, Math.ceil(chrome[i]! + (o.needs?.[s].text ?? 0))));
  let gap = Math.max(MIN_GAP, Math.min(MAX_GAP, Math.round(w * 0.1)));
  // Names before air: the gaps give way for them (never below theirs: `w` holds three least nodes and both).
  if (total(want) + 2 * gap > w) gap = Math.max(MIN_GAP, Math.floor((w - total(want)) / 2));
  const room = w - 2 * gap;
  const named = share(SIDES.map(() => MIN_NODE_W), want, chrome, room);
  const both = share(named, SIDES.map((s, i) => Math.max(named[i]!, Math.ceil(chrome[i]! + (o.needs?.[s].sub ?? 0)))), chrome, room);
  const [left, center, right] = share(both, both.map((n) => Math.max(n, maxNode)), [0, 0, 0], room) as [number, number, number];
  const x0 = Math.max(0, Math.floor((w - (left + center + right + 2 * gap)) / 2));
  return { width: w, nodeW: { left, center, right }, gap, x: { left: x0, center: x0 + left + gap, right: x0 + left + gap + center + gap } };
}

/** How far apart the curves of several keys between the same two tables leave their side node. */
const FAN = 7;

/**
 * Each edge as an SVG path: a curve from a side node's inner edge to the middle node's (several keys between the same
 * two tables leave the side node fanned apart, within its height), a self-reference as a loop over the middle node.
 */
export function edgePaths(l: RelLayout, g: RelColumns, o: { nodeH?: number } = {}): { key: string; d: string; self: boolean; edge: RelEdge }[] {
  const nodeH = o.nodeH ?? REL_NODE_H;
  const byKey = new Map(l.nodes.map((n) => [n.key, n]));
  const mid = l.nodes.find((n) => n.side === 'center')!;
  const fans = new Map<string, number>();
  for (const e of l.edges) if (!e.self) { const k = e.from === mid.key ? e.to : e.from; fans.set(k, (fans.get(k) ?? 0) + 1); }
  const seen = new Map<string, number>();
  const half = g.gap / 2;
  let loops = 0;
  return l.edges.map((e, i) => {
    if (e.self) {
      // Several self-references nest: each loop higher and wider than the one before (the count reads).
      const j = loops++;
      const top = mid.y - nodeH / 2;
      const rise = LOOP + LOOP_STEP * j;
      const a = g.x.center + g.nodeW.center * Math.max(0.1, 0.35 - 0.05 * j);
      const b = g.x.center + g.nodeW.center * Math.min(0.9, 0.65 + 0.05 * j);
      return { key: `${i}:${e.fk.name}`, d: `M${a} ${top} C${a} ${top - rise}, ${b} ${top - rise}, ${b} ${top}`, self: true, edge: e };
    }
    const node = byKey.get(e.from === mid.key ? e.to : e.from)!;
    const k = fans.get(node.key) ?? 1;
    const j = seen.get(node.key) ?? 0;
    seen.set(node.key, j + 1);
    // Spread around the node's middle, kept inside it.
    const spread = Math.min(FAN, (nodeH - 8) / Math.max(1, k - 1));
    const y = node.y + (j - (k - 1) / 2) * spread;
    const leftEnd = g.x.left + g.nodeW.left;
    const midEnd = g.x.center + g.nodeW.center;
    const d = node.side === 'left'
      ? `M${leftEnd} ${y} C${leftEnd + half} ${y}, ${g.x.center - half} ${mid.y}, ${g.x.center} ${mid.y}`
      : `M${g.x.right} ${y} C${g.x.right - half} ${y}, ${midEnd + half} ${mid.y}, ${midEnd} ${mid.y}`;
    return { key: `${i}:${e.fk.name}`, d, self: false, edge: e };
  });
}
