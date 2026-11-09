import { describe, expect, test } from 'vitest';
import type { DbFk, DbRelations } from '@shared/databases';
import { edgePaths, layoutRelations, REL_NODE_H, REL_PITCH_MIN, relationsGeometry, relKey, type RelColumns, type RelNeed, type RelSide } from './relations';

// The Relations card's and view's layout: the tables this one points
// to on the left (N:1), those pointing at it on the right (1:N), a self-reference as a loop; nodes evenly spaced, never
// closer than a node and a gap (the height grows instead); the columns at every width, never overlapping.

const fk = (name: string, from: [string, string, string[]], to: [string, string, string[]], indexed = true): DbFk => ({
  name, from: { schema: from[0], table: from[1], columns: from[2] }, to: { schema: to[0], table: to[1], columns: to[2] }, indexed
});
const ORDERS = { schema: 'public', name: 'orders' };
const out = (table: string, col: string, schema = 'public') => fk(`orders_${col}_fkey`, ['public', 'orders', [col]], [schema, table, ['id']]);
const inc = (table: string, schema = 'public') => fk(`${table}_order_id_fkey`, [schema, table, ['order_id']], ['public', 'orders', ['id']]);
const BOARD_4: DbRelations = {
  out: [out('coupons', 'coupon_code'), out('customers', 'customer_id')],
  in: [inc('order_items'), inc('payments'), inc('refunds'), inc('shipments')]
};
const side = (l: ReturnType<typeof layoutRelations>, s: 'left' | 'center' | 'right') => l.nodes.filter((n) => n.side === s);
const gaps = (ys: number[]) => ys.slice(1).map((y, i) => y - ys[i]!);

describe('layoutRelations', () => {
  test('outgoing on the left, incoming on the right, this table in the middle', () => {
    const l = layoutRelations(ORDERS, BOARD_4, 262);
    expect(side(l, 'left').map((n) => n.name)).toEqual(['coupons', 'customers']);
    expect(side(l, 'right').map((n) => n.name)).toEqual(['order_items', 'payments', 'refunds', 'shipments']);
    expect(side(l, 'center')).toEqual([{ key: relKey('center', 'public', 'orders'), schema: 'public', name: 'orders', side: 'center', y: 131, label: 'orders', via: [] }]);
    // One edge per foreign key, from the table holding it to the one it points at, labelled with its columns.
    const c = relKey('center', 'public', 'orders');
    expect(l.edges.map((e) => [e.from, e.to, e.label, e.self])).toEqual([
      [c, relKey('left', 'public', 'coupons'), 'coupon_code', false],
      [c, relKey('left', 'public', 'customers'), 'customer_id', false],
      [relKey('right', 'public', 'order_items'), c, 'order_id', false],
      [relKey('right', 'public', 'payments'), c, 'order_id', false],
      [relKey('right', 'public', 'refunds'), c, 'order_id', false],
      [relKey('right', 'public', 'shipments'), c, 'order_id', false]
    ]);
    expect(side(l, 'left').map((n) => n.via)).toEqual([['coupon_code'], ['customer_id']]);
    expect(l.height).toBe(262);
  });

  test('nodes evenly spaced over the height, each side on its own; the middle one centered', () => {
    const l = layoutRelations(ORDERS, BOARD_4, 262);
    expect(side(l, 'left').map((n) => n.y)).toEqual([65.5, 196.5]);
    expect(side(l, 'right').map((n) => n.y)).toEqual([32.75, 98.25, 163.75, 229.25]);
    expect(new Set(gaps(side(l, 'right').map((n) => n.y)))).toEqual(new Set([65.5]));
    expect(side(l, 'center')[0]!.y).toBe(131);
  });

  test('a self-reference: a loop on this table (flagged), never a node of its own on either side', () => {
    const self = fk('employees_manager_id_fkey', ['public', 'employees', ['manager_id']], ['public', 'employees', ['id']], false);
    const l = layoutRelations({ schema: 'public', name: 'employees' }, { out: [self], in: [self] }, 262);
    expect(l.nodes.map((n) => n.side)).toEqual(['center']);
    const c = relKey('center', 'public', 'employees');
    expect(l.edges).toEqual([{ from: c, to: c, label: 'manager_id', self: true, fk: self }]);
  });

  test('two foreign keys to the same table: one node, an edge (and a label) per key', () => {
    const billing = out('addresses', 'billing_id');
    const shipping = out('addresses', 'shipping_id');
    const l = layoutRelations(ORDERS, { out: [billing, shipping], in: [] }, 262);
    expect(side(l, 'left').map((n) => [n.name, n.via])).toEqual([['addresses', ['billing_id', 'shipping_id']]]);
    expect(l.edges.map((e) => [e.to, e.label, e.fk.name])).toEqual([
      [relKey('left', 'public', 'addresses'), 'billing_id', 'orders_billing_id_fkey'],
      [relKey('left', 'public', 'addresses'), 'shipping_id', 'orders_shipping_id_fkey']
    ]);
  });

  test('a table both pointed at and pointing back: a node on each side; another schema\'s tables named with it', () => {
    const back = fk('customers_last_order_fkey', ['public', 'customers', ['last_order_id']], ['public', 'orders', ['id']]);
    const l = layoutRelations(ORDERS, { out: [out('customers', 'customer_id'), out('plans', 'plan_id', 'billing')], in: [back] }, 262);
    expect(l.nodes.map((n) => [n.side, n.label])).toEqual([['center', 'orders'], ['left', 'billing.plans'], ['left', 'customers'], ['right', 'customers']]);
    expect(new Set(l.nodes.map((n) => n.key)).size).toBe(4);
    // A name with a slash or a dot never makes two tables one key.
    expect(relKey('left', 'a.b', 'c')).not.toBe(relKey('left', 'a', 'b.c'));
    expect(relKey('left', 'a/b', 'c')).not.toBe(relKey('left', 'a', 'b/c'));
  });

  test('many relations (more than 12 a side): never closer than a node and a gap — the height grows, still even', () => {
    const many: DbRelations = { out: [], in: Array.from({ length: 30 }, (_, i) => inc(`t${String(i).padStart(2, '0')}`)) };
    const l = layoutRelations(ORDERS, many, 262);
    const ys = side(l, 'right').map((n) => n.y);
    expect(ys).toHaveLength(30);
    expect(l.height).toBe(30 * REL_PITCH_MIN);
    expect(new Set(gaps(ys))).toEqual(new Set([REL_PITCH_MIN]));
    expect(REL_PITCH_MIN).toBeGreaterThan(REL_NODE_H);
    // Inside the box, the middle one centered in the grown height.
    expect(ys[0]! - REL_NODE_H / 2).toBeGreaterThanOrEqual(0);
    expect(ys.at(-1)! + REL_NODE_H / 2).toBeLessThanOrEqual(l.height);
    expect(side(l, 'center')[0]!.y).toBe(l.height / 2);
    // Thirteen on one side already doesn't fit 262 px: spread too.
    const thirteen = layoutRelations(ORDERS, { out: [], in: many.in.slice(0, 13) }, 262);
    expect(thirteen.height).toBe(13 * REL_PITCH_MIN);
    // A bigger node (the Relations view) spreads by its own pitch.
    expect(layoutRelations(ORDERS, many, 262, { nodeH: 46 }).height).toBe(30 * (46 + 10));
  });

  test('no relations: this table alone, in the middle', () => {
    const l = layoutRelations(ORDERS, { out: [], in: [] }, 120);
    expect(l.nodes.map((n) => [n.side, n.y])).toEqual([['center', 60]]);
    expect(l.edges).toEqual([]);
  });
});

const SIDES = ['left', 'center', 'right'] as const;
/** The columns side by side, a gap between each two, inside the box (never overlapping). */
function holds(g: RelColumns): void {
  expect(g.x.left).toBeGreaterThanOrEqual(0);
  expect(g.x.left + g.nodeW.left + g.gap).toBe(g.x.center);
  expect(g.x.center + g.nodeW.center + g.gap).toBe(g.x.right);
  expect(g.x.right + g.nodeW.right).toBeLessThanOrEqual(g.width);
  expect(g.gap).toBeGreaterThanOrEqual(16);
  for (const s of SIDES) expect(g.nodeW[s], s).toBeGreaterThanOrEqual(56);
}

describe('relationsGeometry: three columns at every width, never overlapping', () => {
  test.each([280, 430, 1200])('%i px: inside the box, a gap between columns, node widths within bounds', (width) => {
    const g = relationsGeometry(width);
    holds(g);
    expect(g.width).toBe(width);
    for (const s of SIDES) expect(g.nodeW[s]).toBeLessThanOrEqual(200);
    // Names unknown (a markup render): three equal columns.
    expect(new Set(SIDES.map((s) => g.nodeW[s])).size).toBe(1);
  });

  test('a card of 388 px: nodes of ~104 px, edges between them; a wide view caps the nodes and centers them', () => {
    const card = relationsGeometry(388);
    expect(card.nodeW.left).toBeGreaterThanOrEqual(100);
    expect(card.x.left).toBe(0);
    const wide = relationsGeometry(1200, { maxNode: 240 });
    expect(wide.nodeW).toEqual({ left: 240, center: 240, right: 240 });
    expect(wide.x.left).toBe(1200 - (wide.x.right + wide.nodeW.right));
  });

  test('narrower than three nodes fit: the box keeps its least width (the card scrolls sideways instead)', () => {
    const g = relationsGeometry(120);
    expect(g.width).toBe(3 * 56 + 2 * 16);
    expect(g.x.right + g.nodeW.right).toBeLessThanOrEqual(g.width);
  });
});

// Follow-up 1: "order…", "payme…" in a card with room for them. The
// columns share the width by what their names need, not in thirds; only a width that can't hold them cuts them.
describe('relationsGeometry: names whole when the width holds them (follow-up 1)', () => {
  // Board 4's orders in 11.5 px JetBrains Mono (6.9 px a character): customers the widest on the left, orders in the
  // middle, order_items the widest on the right with its 1:N mark (and its gap) beside it.
  const CH = 6.9;
  const NEEDS: Record<RelSide, RelNeed> = { left: { text: 9 * CH, chrome: 20 }, center: { text: 6 * CH, chrome: 20 }, right: { text: 11 * CH, chrome: 33 } };
  /** The room a side's name has in its node. */
  const room = (g: RelColumns, s: RelSide, n = NEEDS) => g.nodeW[s] - n[s].chrome;

  test.each([
    [322, 'the card at 1600 × 1000'],
    [288, 'the card at 1440 × 900 (the bug\'s screenshot)']
  ])('%i px (%s): every name whole, the columns never overlapping', (width) => {
    const g = relationsGeometry(width, { needs: NEEDS });
    holds(g);
    for (const s of SIDES) expect(room(g, s), s).toBeGreaterThanOrEqual(NEEDS[s].text);
    // Three equal thirds would have cut order_items: its column is the widest.
    expect(g.nodeW.right).toBeGreaterThan(g.nodeW.left);
    expect(g.nodeW.right).toBeGreaterThan(Math.floor((width - 2 * g.gap) / 3));
  });

  test('room to spare: the gap keeps its ~10%, the narrowest nodes widen first (short names: equal columns), up to maxNode', () => {
    const card = relationsGeometry(388, { needs: NEEDS });
    holds(card);
    expect(card.gap).toBe(39);
    for (const s of SIDES) expect(room(card, s), s).toBeGreaterThanOrEqual(NEEDS[s].text);
    expect(card.nodeW.center).toBe(card.nodeW.left);
    expect(card.nodeW.right).toBeGreaterThanOrEqual(card.nodeW.left);
    const short: Record<RelSide, RelNeed> = { left: { text: 20, chrome: 20 }, center: { text: 20, chrome: 20 }, right: { text: 20, chrome: 33 } };
    expect(relationsGeometry(388, { needs: short }).nodeW).toEqual(relationsGeometry(388).nodeW);
    const wide = relationsGeometry(1200, { maxNode: 240, needs: NEEDS });
    expect(wide.nodeW).toEqual({ left: 240, center: 240, right: 240 });
    expect(wide.x.left).toBe(1200 - (wide.x.right + wide.nodeW.right));
  });

  test('a long name past maxNode: whole when the width holds it (maxNode caps the air, never a name)', () => {
    const long = { ...NEEDS, right: { text: 40 * CH, chrome: 33 } };
    const g = relationsGeometry(1200, { maxNode: 240, needs: long });
    holds(g);
    expect(room(g, 'right', long)).toBeGreaterThanOrEqual(40 * CH);
    expect(g.nodeW.left).toBe(240);
  });

  test('narrower than the names: the gaps give way first, then every cut name keeps the same room — the 1:N mark\'s on top', () => {
    // 300 px: the ~10% gaps would cut them; narrower ones hold them.
    const g300 = relationsGeometry(300, { needs: NEEDS });
    holds(g300);
    for (const s of SIDES) expect(room(g300, s), s).toBeGreaterThanOrEqual(NEEDS[s].text);
    // 240 px: orders whole, customers and order_items cut to the same length (the mark never eats into its name).
    const g = relationsGeometry(240, { needs: NEEDS });
    holds(g);
    expect(g.gap).toBe(16);
    expect(room(g, 'center')).toBeGreaterThanOrEqual(NEEDS.center.text);
    expect(room(g, 'left')).toBeLessThan(NEEDS.left.text);
    expect(room(g, 'right')).toBeLessThan(NEEDS.right.text);
    expect(Math.abs(room(g, 'right') - room(g, 'left'))).toBeLessThanOrEqual(1);
    expect(g.x.right + g.nodeW.right).toBeLessThanOrEqual(240);
  });

  test('the view\'s second lines (the keys\' columns, 10.5 px): whole once every name is, never at a name\'s cost', () => {
    // The Relations view's nodes (12 px: 7.2 px a character): customer_id under customers is wider than the name.
    const VIEW: Record<RelSide, RelNeed> = {
      left: { text: 9 * 7.2, chrome: 24, sub: 11 * 6.3 }, center: { text: 6 * 7.2, chrome: 24 }, right: { text: 11 * 7.2, chrome: 38, sub: 8 * 6.3 }
    };
    const sub = (g: RelColumns, s: 'left' | 'right') => room(g, s, VIEW) >= VIEW[s].sub!;
    // A 430 px pane's view (382 px): room for both lines.
    const g = relationsGeometry(382, { maxNode: 240, needs: VIEW });
    holds(g);
    for (const s of SIDES) expect(room(g, s, VIEW), s).toBeGreaterThanOrEqual(VIEW[s].text);
    expect(sub(g, 'left') && sub(g, 'right')).toBe(true);
    // Just the names' width: the names whole, customer_id cut (the gaps never give way for it).
    const tight = relationsGeometry(310, { maxNode: 240, needs: VIEW });
    for (const s of SIDES) expect(room(tight, s, VIEW), s).toBeGreaterThanOrEqual(VIEW[s].text);
    expect(sub(tight, 'left')).toBe(false);
    expect(relationsGeometry(310, { maxNode: 240, needs: { ...VIEW, left: { ...VIEW.left, sub: 0 } } }).gap).toBe(tight.gap);
  });

  test('the card in a 280 px pane (208 px): the 1:N mark never squeezes its name to nothing; at the least width, the least nodes', () => {
    const g = relationsGeometry(208, { needs: NEEDS });
    holds(g);
    // Three letters and the ellipsis, at least, beside the mark.
    expect(room(g, 'right')).toBeGreaterThanOrEqual(4 * CH);
    const least = relationsGeometry(120, { needs: NEEDS });
    expect(least.width).toBe(3 * 56 + 2 * 16);
    expect(least.nodeW).toEqual({ left: 56, center: 56, right: 56 });
  });
});

describe('edgePaths', () => {
  test('from a side node\'s inner edge to the middle node\'s, as curves; a self-reference as a loop over the middle node', () => {
    const g = relationsGeometry(388);
    const l = layoutRelations(ORDERS, BOARD_4, 262);
    const paths = edgePaths(l, g);
    expect(paths).toHaveLength(6);
    const toCoupons = paths[0]!;
    // Starts at the left node's right edge, at its height; ends at the middle node's left edge, at its height.
    expect(toCoupons.d).toBe(`M${g.x.left + g.nodeW.left} 65.5 C${g.x.left + g.nodeW.left + g.gap / 2} 65.5, ${g.x.center - g.gap / 2} 131, ${g.x.center} 131`);
    const fromShipments = paths[5]!;
    expect(fromShipments.d.startsWith(`M${g.x.right} 229.25 `)).toBe(true);
    expect(fromShipments.d.endsWith(` ${g.x.center + g.nodeW.center} 131`)).toBe(true);
    const self = fk('employees_manager_id_fkey', ['public', 'employees', ['manager_id']], ['public', 'employees', ['id']]);
    const loop = edgePaths(layoutRelations({ schema: 'public', name: 'employees' }, { out: [self], in: [self] }, 262), g)[0]!;
    expect(loop.self).toBe(true);
    const top = 131 - REL_NODE_H / 2;
    expect(loop.d).toMatch(new RegExp(`^M[\\d.]+ ${top} C[\\d.]+ ${top - 28}, [\\d.]+ ${top - 28}, [\\d.]+ ${top}$`));
  });

  test('columns of their own widths (follow-up 1): each curve leaves its own node\'s edge and reaches the middle node\'s; the loop over the middle node', () => {
    const g = relationsGeometry(322, { needs: { left: { text: 62, chrome: 20 }, center: { text: 41, chrome: 20 }, right: { text: 76, chrome: 33 } } });
    expect(new Set(SIDES.map((s) => g.nodeW[s])).size).toBe(3);
    const paths = edgePaths(layoutRelations(ORDERS, BOARD_4, 262), g);
    const ends = (d: string) => { const n = d.match(/-?[\d.]+/g)!.map(Number); return [n[0], n.at(-2)]; };
    expect(ends(paths[0]!.d)).toEqual([g.x.left + g.nodeW.left, g.x.center]);
    expect(ends(paths[5]!.d)).toEqual([g.x.right, g.x.center + g.nodeW.center]);
    const self = fk('orders_parent_fkey', ['public', 'orders', ['parent_id']], ['public', 'orders', ['id']]);
    const loop = edgePaths(layoutRelations(ORDERS, { out: [self], in: [self] }, 262), g)[0]!;
    const [a, b] = ends(loop.d);
    expect(a).toBeGreaterThan(g.x.center);
    expect(b).toBeLessThan(g.x.center + g.nodeW.center);
  });

  test('several self-references: one loop each, nested apart (the count reads); the height leaves room for the tallest', () => {
    const g = relationsGeometry(388);
    const self = (col: string) => fk(`employees_${col}_fkey`, ['public', 'employees', [col]], ['public', 'employees', ['id']]);
    const keys = [self('manager_id'), self('mentor_id'), self('buddy_id')];
    const l = layoutRelations({ schema: 'public', name: 'employees' }, { out: keys, in: keys }, 120);
    expect(l.edges.filter((e) => e.self).map((e) => e.label)).toEqual(['manager_id', 'mentor_id', 'buddy_id']);
    const loops = edgePaths(l, g).filter((p) => p.self);
    expect(new Set(loops.map((p) => p.d)).size).toBe(3);
    const peak = (d: string) => Number(/ C[\d.]+ ([\d.-]+),/.exec(d)![1]);
    const peaks = loops.map((p) => peak(p.d));
    expect(peaks[1]!).toBeLessThan(peaks[0]!);
    expect(peaks[2]!).toBeLessThan(peaks[1]!);
    // The tallest loop stays inside the box.
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
  });

  test('two keys to one table: their curves leave the node apart (fanned), never drawn as one line', () => {
    const g = relationsGeometry(388);
    const l = layoutRelations(ORDERS, { out: [out('addresses', 'billing_id'), out('addresses', 'shipping_id')], in: [] }, 262);
    const [a, b] = edgePaths(l, g);
    expect(a!.d).not.toBe(b!.d);
    const startY = (d: string) => Number(/^M[\d.]+ ([\d.]+)/.exec(d)![1]);
    expect(Math.abs(startY(a!.d) - startY(b!.d))).toBeGreaterThanOrEqual(6);
    // Within the node's height.
    for (const p of [a!, b!]) expect(Math.abs(startY(p.d) - 131)).toBeLessThan(REL_NODE_H / 2);
  });
});
