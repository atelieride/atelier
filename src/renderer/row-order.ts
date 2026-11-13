// The sidebar's own order for unpinned rows: one list of terminal ids for sessions and one for terminals, per project
// root, saved in localStorage like the pins. Pinned rows keep the pins' order. Pure, but for load and save.
import { MAX_PINNED_PROJECTS } from './pins';

export type RowKind = 'sessions' | 'terminals';

/**
 * Ids in the order the rows were put in by hand. A row switches between session and terminal (Claude exits, `claude`
 * typed in a shell): each kind has its own list, so it arrives in the other list as a row never placed there, and
 * finds its place back when it switches again.
 */
export interface ManualOrder { sessions: string[]; terminals: string[] }

/** The run of rows a dragged row can move within: one list's pinned or unpinned rows of one kind, in shown order. */
export interface Band { kind: RowKind; pinned: boolean; ids: string[] }

export const EMPTY_ORDER: ManualOrder = { sessions: [], terminals: [] };
export const ORDER_KEY = 'atelier.order';

const idsOf = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];

/** From the saved value (whatever it contains) to valid orders; a project with nothing valid is left out. */
export function parseOrder(raw: string | null): Record<string, ManualOrder> {
  let o: Record<string, unknown> = {};
  try { const v: unknown = raw ? JSON.parse(raw) : {}; if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>; } catch { /* broken: no order */ }
  const out: Record<string, ManualOrder> = {};
  for (const [root, value] of Object.entries(o)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { sessions, terminals } = value as Record<string, unknown>;
    const order = { sessions: idsOf(sessions), terminals: idsOf(terminals) };
    if (order.sessions.length || order.terminals.length) out[root] = order;
  }
  return out;
}

/** The order of `root` replaced (empty: the project is removed); the project becomes the most recent one. */
export function withProjectOrder(all: Record<string, ManualOrder>, root: string, order: ManualOrder): Record<string, ManualOrder> {
  const rest = Object.entries(all).filter(([r]) => r !== root);
  if (order.sessions.length || order.terminals.length) rest.push([root, order]);
  return Object.fromEntries(rest.slice(-MAX_PINNED_PROJECTS));
}

export function loadOrder(root: string): ManualOrder {
  try { return parseOrder(localStorage.getItem(ORDER_KEY))[root] ?? EMPTY_ORDER; } catch { return EMPTY_ORDER; }
}

export function saveOrder(root: string, order: ManualOrder): void {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(withProjectOrder(parseOrder(localStorage.getItem(ORDER_KEY)), root, order))); } catch { /* not saved: stays for this session */ }
}

/**
 * Rows placed by hand in their manual order; the others (never placed) keep the order they came in, before the placed
 * ones (Idle: the latest to arrive on top) or after them (an ungrouped list: the newest at the bottom).
 */
export function arrangeUnpinned<T extends { id: string }>(rows: T[], order: string[], unplaced: 'first' | 'last'): T[] {
  if (order.length === 0) return rows;
  const at = new Map(order.map((id, i) => [id, i]));
  const placed = rows.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  const rest = rows.filter((x) => !at.has(x.id));
  return unplaced === 'first' ? [...rest, ...placed] : [...placed, ...rest];
}

/** The band once `id` lands before `before` (null: at its end); null when it would stay where it is, or can't move. */
export function moveInBand(ids: string[], id: string, before: string | null): string[] | null {
  const i = ids.indexOf(id);
  if (i < 0 || (before !== null && !ids.includes(before))) return null;
  if (before === id || before === (ids[i + 1] ?? null)) return null;
  const rest = ids.filter((x) => x !== id);
  const j = before === null ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, j), id, ...rest.slice(j)];
}

/**
 * `list` with the band's ids in the band's order, as one block where the band's first already-listed id was (at the end
 * when none was); the other ids keep their order.
 */
export function placeBand(list: string[], band: string[]): string[] {
  const inBand = new Set(band);
  const first = list.findIndex((x) => inBand.has(x));
  const before = first < 0 ? list : list.slice(0, first).filter((x) => !inBand.has(x));
  const after = first < 0 ? [] : list.slice(first).filter((x) => !inBand.has(x));
  return [...before, ...band, ...after];
}

/** Move Up (-1) / Down (1): the row to land before (null: the band's end); undefined when it can't go that way. */
export function stepBefore(ids: string[], id: string, dir: -1 | 1): string | null | undefined {
  const i = ids.indexOf(id);
  if (i < 0 || (dir < 0 && i === 0) || (dir > 0 && i === ids.length - 1)) return undefined;
  return dir < 0 ? ids[i - 1]! : ids[i + 2] ?? null;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Both lists hold the same ids in the same order (nothing to save). */
export function sameOrder(a: ManualOrder, b: ManualOrder): boolean {
  return same(a.sessions, b.sessions) && same(a.terminals, b.terminals);
}

/** A resumed session is a new terminal: the new id takes the old one's place in both lists. */
export function relinkOrder(order: ManualOrder, from: string, to: string): ManualOrder {
  if (from === to || (!order.sessions.includes(from) && !order.terminals.includes(from))) return order;
  const swap = (list: string[]) => list.map((x) => (x === from ? to : x)).filter((x, i, all) => all.indexOf(x) === i);
  return { sessions: swap(order.sessions), terminals: swap(order.terminals) };
}

/** Ids of rows that are gone are dropped; an empty `alive` (nothing arrived yet) drops nothing, as for the pins. */
export function pruneOrder(order: ManualOrder, alive: string[]): ManualOrder {
  if (alive.length === 0) return order;
  const ids = new Set(alive);
  const next = { sessions: order.sessions.filter((x) => ids.has(x)), terminals: order.terminals.filter((x) => ids.has(x)) };
  return same(next.sessions, order.sessions) && same(next.terminals, order.terminals) ? order : next;
}

/** A row moved by hand to another place arrives there as new: out of both lists. */
export function unplace(order: ManualOrder, id: string): ManualOrder {
  if (!order.sessions.includes(id) && !order.terminals.includes(id)) return order;
  return { sessions: order.sessions.filter((x) => x !== id), terminals: order.terminals.filter((x) => x !== id) };
}

/** A list's bands (rows in shown order, the pinned ones first): its pinned rows and its others, each from two rows. */
export function bandsOf(kind: RowKind, rows: { id: string }[], pins: string[]): Band[] {
  const pinned = rows.filter((x) => pins.includes(x.id)).map((x) => x.id);
  const others = rows.filter((x) => !pins.includes(x.id)).map((x) => x.id);
  return [{ kind, pinned: true, ids: pinned }, { kind, pinned: false, ids: others }].filter((b) => b.ids.length >= 2);
}

export function bandWith(bands: Band[], id: string | null): Band | null {
  return id === null ? null : bands.find((b) => b.ids.includes(id)) ?? null;
}

/** Two bands with the same rows in the same order (a memoised row re-renders only when its band really changed). */
export function sameBand(a: Band | undefined, b: Band | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.pinned === b.pinned && same(a.ids, b.ids);
}

/** A row's band as an attribute: the drop target finds the band's rows by it, tests read it. */
export function bandAttr(band: Band | undefined): { 'data-band'?: string } {
  return band ? { 'data-band': `${band.kind}:${band.pinned ? 'pinned' : 'unpinned'}` } : {};
}

/**
 * Where a row dropped at `y` lands among a band's rows (their boxes, in shown order): before the first row whose middle
 * is below the pointer, or at the end; null outside the band.
 */
export function landingAt(rows: { id: string; top: number; height: number }[], y: number): { before: string | null } | null {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last || y < first.top || y >= last.top + last.height) return null;
  const row = rows.find((r) => y < r.top + r.height / 2);
  return { before: row ? row.id : null };
}
