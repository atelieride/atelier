import { expect, test } from 'vitest';
import { emptyGraph, graphWidth, laneX, layoutGraph } from './git-graph';

const L = (spec: string) => spec.split(' ').map((s) => { const [oid, ps] = s.split(':'); return { oid: oid!, parents: ps ? ps.split(',') : [] }; });

test('linear: one lane, straight', () => {
  const { rows } = layoutGraph(L('c:b b:a a'), emptyGraph());
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
  expect(rows[0]!.top).toEqual([]);
  expect(rows[0]!.bottom).toEqual([{ a: 0, b: 0, color: rows[0]!.color }]);
  expect(rows[1]!.top).toEqual([{ a: 0, b: 0, color: rows[0]!.color }]);
  expect(rows[2]!.bottom).toEqual([]);
  expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
});

test('branch + merge: the feature gets lane 1 and merges back', () => {
  const { rows } = layoutGraph(L('m:b,f f:a b:a a'), emptyGraph(), new Set(['m', 'b', 'a']));
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
  expect(rows[0]!.color).toBe(0);
  expect(rows[1]!.color).not.toBe(0);
  expect(rows[0]!.bottom).toEqual(expect.arrayContaining([{ a: 0, b: 0, color: 0 }, { a: 0, b: 1, color: rows[1]!.color }]));
  expect(rows[0]!.bottom).toHaveLength(2);
  expect(rows[2]!.top).toEqual(expect.arrayContaining([{ a: 0, b: 0, color: 0 }, { a: 1, b: 1, color: rows[1]!.color }]));
  expect(rows[3]!.top).toEqual(expect.arrayContaining([{ a: 0, b: 0, color: 0 }, { a: 1, b: 0, color: rows[1]!.color }]));
  expect(rows[3]!.bottom).toEqual([]);
});

test('octopus: three parents, three lanes', () => {
  const { rows } = layoutGraph(L('o:a,b,c c:z b:z a:z z'), emptyGraph(), new Set(['o', 'a', 'z']));
  expect(rows[0]!.bottom.filter((s) => s.a === 0).map((s) => s.b).sort()).toEqual([0, 1, 2]);
  expect(rows.at(-1)!.top.map((s) => s.a).sort()).toEqual([0, 1, 2]);
  expect(rows[0]!.width).toBe(3);
});

test('a freed lane is reused', () => {
  const { rows } = layoutGraph(L('m2:m1,y y:m1 m1:b,x x:a b:a a'), emptyGraph(), new Set(['m2', 'm1', 'b', 'a']));
  expect(rows[1]!.lane).toBe(1); // y
  expect(rows[3]!.lane).toBe(1); // x takes lane 1 again
});

test('page boundary: two pages give the same rows as one', () => {
  const all = L('m:b,f f:e e:a b:a a');
  const ml = new Set(['m', 'b', 'a']);
  const one = layoutGraph(all, emptyGraph(), ml).rows;
  const p1 = layoutGraph(all.slice(0, 2), emptyGraph(), ml);
  const p2 = layoutGraph(all.slice(2), p1.state, ml);
  expect([...p1.rows, ...p2.rows]).toEqual(one);
});

test('the input state is never changed', () => {
  const s = emptyGraph();
  layoutGraph(L('b:a a'), s);
  expect(s).toEqual(emptyGraph());
});

test('without mainline a branch tip newer than HEAD takes lane 0 and HEAD lane 1', () => {
  const { rows } = layoutGraph(L('f:a h:a a'), emptyGraph());
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
});

test('with mainline the current branch keeps lane 0 even when another tip is newer', () => {
  const { rows } = layoutGraph(L('f:a h:a a'), emptyGraph(), new Set(['h', 'a']));
  expect(rows.map((r) => r.lane)).toEqual([1, 0, 0]);
  expect(rows[1]!.top).toEqual([{ a: 1, b: 1, color: rows[0]!.color }]);
  expect(rows[0]!.width).toBe(2);
});

test('colors cycle 1..5 for other chains', () => {
  const tips = 'a b c d e f g'.split(' ').map((x) => `${x}:z`).join(' ');
  const { rows } = layoutGraph(L(`${tips} z`), emptyGraph());
  expect(rows.slice(0, 7).map((r) => r.color)).toEqual([1, 2, 3, 4, 5, 1, 2]);
});

test('a parent outside the loaded history keeps its lane running down', () => {
  const { rows, state } = layoutGraph(L('b:a'), emptyGraph());
  expect(rows[0]!.bottom).toEqual([{ a: 0, b: 0, color: rows[0]!.color }]);
  expect(state.lanes).toEqual(['a']);
});

test('laneX and graphWidth', () => {
  expect(laneX(0)).toBe(9); expect(laneX(1)).toBe(27); expect(laneX(11)).toBe(207);
  expect(laneX(12)).toBe(210); expect(laneX(40)).toBe(225);
  expect(graphWidth(1)).toBe(36); expect(graphWidth(3)).toBe(54); expect(graphWidth(30)).toBe(234);
});
