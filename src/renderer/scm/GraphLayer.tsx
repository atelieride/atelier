// The History graph for the rows on screen: one SVG, one path per lane color, a node per
// commit. Redrawn as the window scrolls; nothing outside the window is in the DOM.
import { memo, type ReactElement } from 'react';
import type { GraphRow } from '@shared/git-graph';
import { LANE_COLORS, laneX } from '@shared/git-graph';
import { WORKTREE_ROW } from './history-model';

const laneColor = (c: number) => `var(--lane-${(c % LANE_COLORS) + 1})`;

function seg(a: number, b: number, y1: number, y2: number): string {
  const x1 = laneX(a); const x2 = laneX(b);
  if (a === b) return `M${x1} ${y1}V${y2}`;
  const m = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
}

export const GraphLayer = memo(function GraphLayer({ rows, oids, merges, start, end, rowH, width, selected }: {
  rows: GraphRow[]; oids: string[]; merges: boolean[]; start: number; end: number; rowH: number; width: number; selected: number | null;
}) {
  const paths = new Map<number, string[]>();
  const add = (color: number, d: string) => { const l = paths.get(color); if (l) l.push(d); else paths.set(color, [d]); };
  const nodes: ReactElement[] = [];
  for (let i = start; i < end; i++) {
    const r = rows[i];
    if (!r || r.lane < 0) continue;
    const y0 = (i - start) * rowH;
    const mid = y0 + rowH / 2;
    const wt = oids[i] === WORKTREE_ROW;
    for (const s of r.top) add(s.color, seg(s.a, s.b, y0, mid));
    if (!wt) for (const s of r.bottom) add(s.color, seg(s.a, s.b, mid, y0 + rowH));
    const x = laneX(r.lane);
    const color = laneColor(r.color);
    nodes.push(
      <g key={i} className={`hv-node ${i === selected ? 'is-selected' : ''} ${wt ? 'is-worktree' : ''}`} style={{ ['--lane' as string]: color }}>
        {i === selected && <circle className="hv-halo" cx={x} cy={mid} r={8} />}
        <circle cx={x} cy={mid} r={merges[i] ? 3.4 : 4} className={merges[i] ? 'is-merge' : ''} />
      </g>
    );
  }
  // The dashed line from the working tree row down to HEAD is that row's bottom segment.
  const wtAt = oids.indexOf(WORKTREE_ROW);
  return (
    <svg className="hv-graph" width={width} height={(end - start) * rowH} style={{ top: start * rowH }} aria-hidden="true">
      {[...paths.entries()].map(([color, ds]) => <path key={color} d={ds.join('')} stroke={laneColor(color)} />)}
      {wtAt >= start && wtAt < end && rows[wtAt] && rows[wtAt]!.bottom.map((s, k) => <path key={`wt${k}`} className="hv-wt-line" d={seg(s.a, s.b, (wtAt - start) * rowH + rowH / 2, (wtAt - start + 1) * rowH)} />)}
      {nodes}
    </svg>
  );
});
