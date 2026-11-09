// The History graph: lanes for commits in topological order, one row at a time. Pure and
// incremental: the state after a page is the next page's input, so paging never redraws what is already shown.

/** A line in half a row: top halves go from lane a at the row's top to lane b at its middle, bottom halves from the middle to the bottom. */
export interface Seg { a: number; b: number; color: number }
export interface GraphRow { lane: number; color: number; top: Seg[]; bottom: Seg[]; width: number }
/** lanes[i]: the commit lane i is heading for (null: free); colors[i]: its color; next: the next color to hand out. */
export interface GraphState { lanes: (string | null)[]; colors: number[]; next: number }

/** Lane colors: 0 (violet) is the current branch's; the other chains cycle through 1..LANE_COLORS-1. */
export const LANE_COLORS = 6;
const LANE_W = 18;
const MAX_LANES = 12;
const SQUEEZE = 3;
const SQUEEZED = 6;

export const emptyGraph = (): GraphState => ({ lanes: [], colors: [], next: 1 });

/**
 * Lanes for commits in topological order (children before parents). `mainline`: the current branch's first-parent
 * chain, always on lane 0 in color 0 — lane 0 is never given to another chain while there is one.
 */
export function layoutGraph(rows: { oid: string; parents: string[] }[], state: GraphState, mainline?: ReadonlySet<string>): { rows: GraphRow[]; state: GraphState } {
  const lanes = [...state.lanes];
  const colors = [...state.colors];
  let next = state.next;
  const reserve = mainline && mainline.size > 0 ? 1 : 0;
  const newColor = () => { const c = next; next = next >= LANE_COLORS - 1 ? 1 : next + 1; return c; };
  const free = () => { for (let i = reserve; i < lanes.length; i++) if (lanes[i] === null || lanes[i] === undefined) return i; return Math.max(lanes.length, reserve); };
  const out: GraphRow[] = [];
  for (const c of rows) {
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.oid) incoming.push(i);
    const onMain = !!mainline?.has(c.oid);
    const node = onMain ? 0 : incoming.length ? Math.min(...incoming) : free();
    const top: Seg[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || lanes[i] === undefined) continue;
      if (incoming.includes(i)) top.push({ a: i, b: node, color: colors[i]! });
      else top.push({ a: i, b: i, color: colors[i]! });
    }
    const came = incoming.includes(node);
    for (const i of incoming) lanes[i] = null;
    while (lanes.length <= node) { lanes.push(null); colors.push(0); }
    const color = came ? colors[node]! : onMain ? 0 : newColor();
    colors[node] = color;
    lanes[node] = c.parents[0] ?? null;
    const created = new Set<number>();
    const edges: Seg[] = [];
    for (const p of c.parents.slice(1)) {
      let k = lanes.findIndex((x, i) => x === p && i !== node);
      if (k < 0) {
        k = free();
        while (lanes.length <= k) { lanes.push(null); colors.push(0); }
        lanes[k] = p;
        colors[k] = newColor();
        created.add(k);
      }
      edges.push({ a: node, b: k, color: colors[k]! });
    }
    const bottom: Seg[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || i === node || created.has(i)) continue;
      bottom.push({ a: i, b: i, color: colors[i]! });
    }
    if (c.parents[0]) bottom.push({ a: node, b: node, color });
    bottom.push(...edges);
    while (lanes.length && lanes.at(-1) === null) { lanes.pop(); colors.pop(); }
    let width = node + 1;
    for (const s of [...top, ...bottom]) width = Math.max(width, s.a + 1, s.b + 1);
    out.push({ lane: node, color, top, bottom: bottom.sort((x, y) => x.a - y.a || x.b - y.b), width });
  }
  return { rows: out, state: { lanes, colors, next } };
}

/** x of a lane's center: 18 px apart; lanes past the 12th squeezed 3 px apart at the right edge. */
export function laneX(lane: number): number {
  if (lane < MAX_LANES) return LANE_W / 2 + lane * LANE_W;
  return LANE_W / 2 + (MAX_LANES - 1) * LANE_W + Math.min(lane - (MAX_LANES - 1), SQUEEZED) * SQUEEZE;
}

/** The graph column's width for that many lanes (at least two). */
export function graphWidth(maxLanes: number): number {
  const n = Math.max(2, maxLanes);
  if (n <= MAX_LANES) return n * LANE_W;
  return MAX_LANES * LANE_W + Math.min(n - MAX_LANES, SQUEEZED) * SQUEEZE;
}
