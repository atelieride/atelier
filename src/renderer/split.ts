// Split view with tab groups: 1 to 3 panes side by side, each with
// its own tabs and its tab in front. Pure functions.
//
// One pane is today's app: the store keeps the `single()` placeholder and its strip order (`tabOrder`) and active key
// say everything. A function that turns one pane into several first `lift`s that order into a real pane. In split mode
// the store's order is always `flatten(split)`, and `reconcile` brings the panes in line with whatever the rest of the
// store did to the order and the active key (a tab opened, closed, a terminal exited, a key activated).
import type { TerminalInfo } from '@shared/protocol';
import { afterClose, moveTab as moveKey, openTab, type TabKey } from './tabs-model';

/** A pane's tab in front, or null: an empty pane (Split Right's, with the picker). */
export type PaneKey = TabKey | null;
/** A pane: its tabs left to right (each tab lives in exactly one pane) and the one it shows. */
export interface Pane { tabs: TabKey[]; front: PaneKey }
export interface Split {
  panes: Pane[];
  /** Index of the focused pane: its front is the store's active tab. */
  focus: number;
  /** Width of each pane as a fraction of the workspace (sum 1). */
  fractions: number[];
}

export const MAX_PANES = 3;
/** How many sessions/terminals the picker of an empty pane offers. */
export const PICKER_MAX = 8;

const equal = (n: number): number[] => Array.from({ length: n }, () => 1 / n);
const one = (pane: Pane): Split => ({ panes: [pane], focus: 0, fractions: [1] });

/** One pane: a placeholder, the store's order and active key are its tabs and its front. */
export function single(): Split {
  return one({ tabs: [], front: null });
}

export function isSplit(s: Split): boolean {
  return s.panes.length > 1;
}

/** The pane holding `key` in split mode; -1 otherwise (one pane, or a key in no pane). */
export function paneOf(s: Split, key: TabKey): number {
  return isSplit(s) ? s.panes.findIndex((p) => p.tabs.includes(key)) : -1;
}

/** Each pane's tab in front, left to right (split mode; one pane: none, the active key is it). */
export function fronts(s: Split): PaneKey[] {
  return isSplit(s) ? s.panes.map((p) => p.front) : [];
}

/** The tabs on screen in split mode: every pane's tab in front. */
export function visibleKeys(s: Split): TabKey[] {
  return fronts(s).filter((k): k is TabKey => k !== null);
}

/** Every pane's tabs, left to right: the store's order in split mode. */
export function flatten(s: Split): TabKey[] {
  return s.panes.flatMap((p) => p.tabs);
}

/** The tabs strip `i` shows: one pane, the whole order; split mode, that pane's own tabs. */
export function stripKeys(s: Split, order: TabKey[], i: number): TabKey[] {
  return isSplit(s) ? s.panes[i]?.tabs ?? [] : order;
}

/**
 * One pane made real from the strip order and the active key (so it can be split); a split as it is. An active key not
 * in the order (a terminal launched, not listed yet) leaves the last tab in front: never tabs without one.
 */
export function lift(s: Split, order: TabKey[], active: PaneKey): Split {
  if (isSplit(s)) return s;
  return one({ tabs: [...order], front: active !== null && order.includes(active) ? active : order.at(-1) ?? null });
}

const samePane = (a: Pane, b: Pane) => a.front === b.front && a.tabs.length === b.tabs.length && a.tabs.every((k, i) => k === b.tabs[i]);
/** `next` if anything differs from `s`, else `s` itself (callers compare by identity). */
function settled(s: Split, next: Split): Split {
  const same = s.focus === next.focus && s.panes.length === next.panes.length && s.panes.every((p, i) => samePane(p, next.panes[i]!))
    && s.fractions.every((f, i) => f === next.fractions[i]);
  return same ? s : next;
}

/**
 * Drops the panes `drop` says (by index): the focused pane survives if it can, otherwise the focus goes to the nearest
 * surviving pane on its left, then on its right. The panes left keep their proportions. None left: one empty pane.
 */
function dropAt(s: Split, drop: (i: number) => boolean): Split {
  const keep = s.panes.map((_, i) => !drop(i));
  if (keep.every(Boolean)) return s;
  const panes = s.panes.filter((_, i) => keep[i]);
  if (panes.length === 0) return one({ tabs: [], front: null });
  if (panes.length === 1) return one(panes[0]!);
  let target = s.focus;
  if (!keep[target]) {
    target = -1;
    for (let i = s.focus - 1; i >= 0 && target < 0; i--) if (keep[i]) target = i;
    for (let i = s.focus + 1; i < s.panes.length && target < 0; i++) if (keep[i]) target = i;
  }
  const focus = keep.slice(0, target).filter(Boolean).length;
  return { panes, focus, fractions: normalized(s.fractions.filter((_, i) => keep[i]), panes.length) };
}

/** Fractions scaled to sum 1; anything unusable (wrong length, not positive, NaN) becomes equal shares. */
function normalized(fractions: number[], n: number): number[] {
  if (fractions.length !== n || fractions.some((f) => !Number.isFinite(f) || f <= 0)) return equal(n);
  const sum = fractions.reduce((a, b) => a + b, 0);
  return fractions.map((f) => f / sum);
}

/**
 * Tabs closed, exited, moved away: each leaves its pane, which shows its own most recently used tab, then its
 * nearest one on the right, then on the left (`afterClose` on the pane's tabs). A pane that loses its last tab closes
 *; an empty pane that had none (Split Right's) stays.
 */
export function removeKeys(s: Split, gone: (k: TabKey) => boolean, recent: TabKey[]): Split {
  let changed = false;
  const lost: boolean[] = [];
  const panes = s.panes.map((p) => {
    const closing = p.tabs.filter(gone);
    lost.push(closing.length > 0 && closing.length === p.tabs.length);
    if (closing.length === 0) return p;
    changed = true;
    const tabs = p.tabs.filter((k) => !gone(k));
    return { tabs, front: tabs.length === 0 ? null : afterClose(p.tabs, closing, p.front, recent) };
  });
  if (!changed) return s;
  return dropAt({ ...s, panes }, (i) => lost[i]!);
}

/** The index each key has in `order` (keys missing from it sort last, in their current order). */
function byOrder(order: TabKey[]): (a: TabKey, b: TabKey) => number {
  const at = new Map(order.map((k, i) => [k, i]));
  return (a, b) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity);
}

/** The nearest pane with tabs to `i`, left first; `i` itself when none has any. */
function nearestWithTabs(panes: Pane[], i: number): number {
  for (let d = 1; d < panes.length; d++) {
    for (const j of [i - d, i + d]) if (panes[j] && panes[j]!.tabs.length > 0) return j;
  }
  return i;
}

/**
 * The panes after the rest of the store changed the order or the active key (split mode; one pane: the same object):
 * - keys gone from the order leave their pane (removeKeys);
 * - keys new to the order join the focused pane — an empty focused pane takes only the active key, the others wait in
 *   the nearest pane with tabs — where the order put them (after the front: `insertAfterActive`, `openTab`);
 * - the order decides the order inside each pane;
 * - the active key in the focused pane comes to its front; in another pane the focus goes there (nothing moves); with
 *   an empty focused pane, another pane's non-front tab moves into it.
 */
export function reconcile(s: Split, order: TabKey[], active: PaneKey, recent: TabKey[]): Split {
  if (!isSplit(s)) return s;
  const inOrder = new Set(order);
  let next = removeKeys(s, (k) => !inOrder.has(k), recent);
  const known = new Set(flatten(next));
  const added = order.filter((k) => !known.has(k));
  const sort = byOrder(order);
  let panes = next.panes.map((p) => ({ tabs: [...p.tabs].sort(sort), front: p.front }));
  if (added.length) {
    const focused = panes[next.focus]!;
    const wait = focused.tabs.length > 0 ? next.focus : nearestWithTabs(panes, next.focus);
    for (const k of added) {
      const to = k === active ? next.focus : wait;
      panes[to] = { tabs: [...panes[to]!.tabs, k].sort(sort), front: panes[to]!.front };
    }
  }
  let focus = next.focus;
  if (active !== null) {
    const at = panes.findIndex((p) => p.tabs.includes(active));
    if (at === focus) panes[at] = { ...panes[at]!, front: active };
    else if (at >= 0 && panes[focus]!.tabs.length === 0 && panes[at]!.front !== active) {
      // The empty pane takes it (as its picker would): it leaves the other pane, whose front stays.
      panes[at] = { tabs: panes[at]!.tabs.filter((k) => k !== active), front: panes[at]!.front };
      panes[focus] = { tabs: [active], front: active };
    } else if (at >= 0) {
      focus = at;
      panes[at] = { ...panes[at]!, front: active };
    }
  }
  // A pane with tabs always shows one: its most recently used, else its last.
  panes = panes.map((p) => (p.tabs.length > 0 && (p.front === null || !p.tabs.includes(p.front))
    ? { ...p, front: [...recent].reverse().find((k) => p.tabs.includes(k)) ?? p.tabs.at(-1)! }
    : p));
  next = { ...next, panes, focus };
  if (next.panes.length === 1) return settled(s, one(next.panes[0]!));
  return settled(s, next);
}

export function focusPane(s: Split, i: number): Split {
  if (i < 0 || i >= s.panes.length || i === s.focus) return s;
  return { ...s, focus: i };
}

/** ⌘⌥→ / ⌘⌥←: the next / previous pane, wrapping around. */
export function focusStep(s: Split, dir: 1 | -1): Split {
  if (!isSplit(s)) return s;
  return { ...s, focus: (s.focus + dir + s.panes.length) % s.panes.length };
}

/** ⌘\: an empty pane right of the focused one, focused; null at MAX_PANES (the caller says why). */
export function splitRight(s: Split, order: TabKey[], active: PaneKey): Split | null {
  const base = lift(s, order, active);
  if (base.panes.length >= MAX_PANES) return null;
  const at = base.focus + 1;
  const panes = [...base.panes.slice(0, at), { tabs: [], front: null }, ...base.panes.slice(at)];
  return { panes, focus: at, fractions: equal(panes.length) };
}

/** A pane without `key` (it moved away): it shows its own previous tab, or nothing once emptied. */
function without(p: Pane, key: TabKey, recent: TabKey[]): Pane {
  const tabs = p.tabs.filter((k) => k !== key);
  return { tabs, front: tabs.length === 0 ? null : afterClose(p.tabs, [key], p.front, recent) };
}

/** `key` inserted before `before` (null, or a key not there: at the end). */
function insertBefore(tabs: TabKey[], key: TabKey, before: TabKey | null): TabKey[] {
  const at = before ? tabs.indexOf(before) : -1;
  return at >= 0 ? [...tabs.slice(0, at), key, ...tabs.slice(at)] : [...tabs, key];
}

/**
 * A tab moved into pane `to`, before `before` (null: at the end) — a drop on its strip, a drop on its body, a menu
 *: there it comes to the front and that pane takes the focus. Within its own pane: a reorder. The pane it
 * leaves shows its previous tab, or closes if emptied.
 */
export function moveTab(s: Split, key: TabKey, to: number, before: TabKey | null, recent: TabKey[]): Split {
  const from = s.panes.findIndex((p) => p.tabs.includes(key));
  if (from < 0 || to < 0 || to >= s.panes.length) return s;
  if (from === to) {
    // Within its own strip: a reorder only, as in one pane's strip (its front stays).
    const tabs = moveKey(s.panes[to]!.tabs, key, before);
    return settled(s, { ...s, panes: s.panes.map((p, i) => (i === to ? { tabs, front: p.front } : p)), focus: to });
  }
  const panes = s.panes.map((p, i) => (i === to ? { tabs: insertBefore(p.tabs, key, before), front: key } : i === from ? without(p, key, recent) : p));
  const emptied = panes[from]!.tabs.length === 0;
  return dropAt({ ...s, panes, focus: to }, (i) => emptied && i === from);
}

/** Room for another pane, and `key` isn't alone in its pane (one pane: the strip order is its pane). */
export function canMoveToNewPane(s: Split, order: TabKey[], key: TabKey): boolean {
  if (s.panes.length >= MAX_PANES) return false;
  if (!isSplit(s)) return order.includes(key) && order.length > 1;
  const p = s.panes.find((x) => x.tabs.includes(key));
  return !!p && p.tabs.length > 1;
}

/**
 * A new pane on `side` of pane `at`, holding only `key`, focused, widths equal (an edge drop, Move to New Pane Right,
 * ⌃⌘ at the edge). Null at MAX_PANES, and for a tab alone in pane `at` (it would only move its own pane). Another
 * pane's only tab: its old pane closes.
 */
export function moveToNewPane(s: Split, order: TabKey[], active: PaneKey, key: TabKey, at: number, side: 'left' | 'right', recent: TabKey[]): Split | null {
  const base = lift(s, order, active);
  if (base.panes.length >= MAX_PANES) return null;
  const from = base.panes.findIndex((p) => p.tabs.includes(key));
  if (from < 0 || at < 0 || at >= base.panes.length) return null;
  if (from === at && base.panes[from]!.tabs.length === 1) return null;
  const ins = side === 'left' ? at : at + 1;
  const panes = base.panes.map((p, i) => (i === from ? without(p, key, recent) : p));
  panes.splice(ins, 0, { tabs: [key], front: key });
  const src = from >= ins ? from + 1 : from;
  const emptied = panes[src]!.tabs.length === 0;
  return dropAt({ panes, focus: ins, fractions: equal(panes.length) }, (i) => emptied && i === src);
}

/**
 * ⌃⌘← / ⌃⌘→: the focused pane's tab in front to the end of the neighbour on that side; from the edge pane,
 * a new pane there (room and company permitting). Null when nothing can happen.
 */
export function moveStep(s: Split, order: TabKey[], active: PaneKey, dir: 1 | -1, recent: TabKey[]): Split | null {
  const base = lift(s, order, active);
  const key = base.panes[base.focus]!.front;
  if (!key) return null;
  const to = base.focus + dir;
  if (to >= 0 && to < base.panes.length) return moveTab(base, key, to, null, recent);
  return moveToNewPane(base, order, active, key, base.focus, dir === 1 ? 'right' : 'left', recent);
}

/** ⌃⌘← / ⌃⌘→ would do something (the palette offers them only then). */
export function canMoveStep(s: Split, order: TabKey[], active: PaneKey, dir: 1 | -1): boolean {
  return moveStep(s, order, active, dir, []) !== null;
}

/**
 * Open to the Side: a key in another pane only takes the focus there (to its front); otherwise it goes to
 * the pane right of the focused one — a new one while there is room, else the right neighbour (from the last pane, the
 * left one). A tab alone in the focused pane has nothing to split off: unchanged.
 */
export function openToSide(s: Split, order: TabKey[], active: PaneKey, key: TabKey, recent: TabKey[]): Split {
  const base = lift(s, order, active);
  const at = base.panes.findIndex((p) => p.tabs.includes(key));
  if (at >= 0 && at !== base.focus) return settled(s, { ...base, panes: base.panes.map((p, i) => (i === at ? { ...p, front: key } : p)), focus: at });
  if (at === base.focus && base.panes[at]!.tabs.length === 1) return s;
  const n = base.panes.length;
  if (n < MAX_PANES) {
    if (at === base.focus) return moveToNewPane(base, order, active, key, base.focus, 'right', recent) ?? s;
    const ins = base.focus + 1;
    const panes = [...base.panes.slice(0, ins), { tabs: [key], front: key }, ...base.panes.slice(ins)];
    return { panes, focus: ins, fractions: equal(panes.length) };
  }
  const target = base.focus < n - 1 ? base.focus + 1 : base.focus - 1;
  if (at === base.focus) return moveTab(base, key, target, null, recent);
  return { ...base, panes: base.panes.map((p, i) => (i === target ? { tabs: [...p.tabs, key], front: key } : p)), focus: target };
}

/**
 * The pane × — Unsplit: pane `i` goes and its tabs join the neighbour (left; the first pane's, right),
 * keeping the left-to-right order. The neighbour's front stays in front (an empty one takes the leaving pane's) and it
 * takes the focus; its width grows by the leaving pane's. Nothing closes.
 */
export function unsplit(s: Split, i: number): Split {
  if (!isSplit(s) || i < 0 || i >= s.panes.length) return s;
  const to = i > 0 ? i - 1 : 1;
  const p = s.panes[i]!;
  const q = s.panes[to]!;
  const tabs = to < i ? [...q.tabs, ...p.tabs] : [...p.tabs, ...q.tabs];
  const merged: Pane = { tabs, front: q.front ?? p.front ?? tabs[0] ?? null };
  const panes = s.panes.map((x, j) => (j === to ? merged : x)).filter((_, j) => j !== i);
  if (panes.length === 1) return one(panes[0]!);
  const fractions = s.fractions.map((f, j) => (j === to ? f + s.fractions[i]! : f)).filter((_, j) => j !== i);
  return { panes, focus: to < i ? to : to - 1, fractions: normalized(fractions, panes.length) };
}

/** Unsplit All: one pane, every tab in pane order; the focused pane's front stays in front. */
export function unsplitAll(s: Split): Split {
  if (!isSplit(s)) return s;
  const front = s.panes[s.focus]!.front ?? s.panes.map((p) => p.front).find((k) => k !== null) ?? null;
  return one({ tabs: flatten(s), front });
}

/** Where pane `i`'s × sends its tabs and how many (its tooltip and the tabs it lights); null with one pane. */
export function unsplitTarget(s: Split, i: number): { to: 'left' | 'right'; count: number } | null {
  if (!isSplit(s) || i < 0 || i >= s.panes.length) return null;
  return { to: i > 0 ? 'left' : 'right', count: s.panes[i]!.tabs.length };
}

/**
 * A pane's grid cell: row 1 its bar (a Claude session's session bar), row 2 the content under it, or both rows for a
 * pane without a bar (`full`: anything but a session). Both lines explicit: for an absolutely
 * positioned view an `auto` end line is the grid container's edge, so `grid-column: 2` alone would run over the panes on
 * its right.
 */
export function paneCell(i: number, row: 'head' | 'body' | 'full'): { gridColumn: string; gridRow: string } {
  const rows = row === 'head' ? '1 / 2' : row === 'body' ? '2 / 3' : '1 / 3';
  return { gridColumn: `${i + 1} / ${i + 2}`, gridRow: rows };
}

/**
 * Where a tab opened from a click goes, with a window's preview slot (files' and tables'): openTab's
 * placement, except that a preview shown in a pane that isn't focused is never replaced (it stays there, the new tab
 * opens after the active one); a replaced preview gives the new key its place in its pane in the same result — never a
 * pane that looks emptied for a moment (and closes) while the new key arrives. `preview`: the slot the caller may replace
 * (a file with unsaved edits: none). The panes come back unchanged (the same object) when nothing was replaced.
 */
export function placeOpened(s: Split, order: TabKey[], active: TabKey | null, key: TabKey, preview: TabKey | null, asPreview: boolean): { order: TabKey[]; preview: TabKey | null; replaced: TabKey | null; split: Split } {
  const elsewhere = preview !== null && isSplit(s) && paneOf(s, preview) >= 0 && paneOf(s, preview) !== s.focus;
  const placed = openTab(order, key, active, elsewhere ? null : preview, asPreview);
  const split = placed.replaced && isSplit(s) ? renameKeys(s, (k) => (k === placed.replaced ? key : k)) : s;
  return { ...placed, split };
}

/** Tabs that changed key (a renamed file, an untitled tab saved as a file) stay in their pane. */
export function renameKeys(s: Split, rename: (key: TabKey) => TabKey): Split {
  let changed = false;
  const panes = s.panes.map((p) => {
    const tabs = p.tabs.map(rename);
    const front = p.front === null ? null : rename(p.front);
    if (front === p.front && tabs.every((k, i) => k === p.tabs[i])) return p;
    changed = true;
    return { tabs, front };
  });
  return changed ? { ...s, panes } : s;
}

/** Where a dragged tab lands over a pane: its left/right edge band (a new pane on that side) or its middle (into it). */
export type DropZone = 'left' | 'middle' | 'right';
/** Edge bands: 24% of the pane's width, at least 48 px. */
export const EDGE_BAND = 0.24;
export const EDGE_MIN_PX = 48;

/** The zone under `x` in a pane (screen coordinates); with three panes there is no room for another: always the middle. */
export function dropZone(pane: { left: number; width: number }, x: number, paneCount: number): DropZone {
  if (paneCount >= MAX_PANES) return 'middle';
  const band = Math.min(Math.max(pane.width * EDGE_BAND, EDGE_MIN_PX), pane.width / 3);
  if (x < pane.left + band) return 'left';
  if (x > pane.left + pane.width - band) return 'right';
  return 'middle';
}

/** Panes never get narrower than this when the workspace has room for all of them (otherwise: equal shares). */
export const MIN_PANE_PX = 240;
/** Arrow keys on a focused divider move it by this much. */
export const DIVIDER_STEP_PX = 24;

/**
 * Divider `i` (between panes i and i+1) dragged by `dx` px in a workspace whose panes add up to `width` px: only those
 * two panes change, neither below MIN_PANE_PX. Too narrow for every pane's minimum: unchanged (they are shown equal).
 */
export function dragDivider(fractions: number[], i: number, dx: number, width: number, min = MIN_PANE_PX): number[] {
  const n = fractions.length;
  if (i < 0 || i >= n - 1 || width <= 0 || width < n * min) return fractions;
  const m = min / width;
  const pair = fractions[i]! + fractions[i + 1]!;
  if (pair < 2 * m) return fractions;
  const left = Math.min(Math.max(fractions[i]! + dx / width, m), pair - m);
  return fractions.map((f, j) => (j === i ? left : j === i + 1 ? pair - left : f));
}

/** The pane columns: each fraction as `fr`, never below MIN_PANE_PX — or an equal share when the workspace is too narrow for that. */
export function gridColumns(fractions: number[]): string {
  const n = fractions.length;
  const floor = `min(${MIN_PANE_PX}px, calc((100% - ${n - 1}px) / ${n}))`;
  return fractions.map((f) => `minmax(${floor}, ${f}fr)`).join(' ');
}

/**
 * What is saved per project and per workspace: every pane's tabs (any kind) and front, the widths and the
 * focused pane. Version 1 (v2.1, before tab groups) saved one key per pane: `{ panes: TabKey[], fractions, focus }`.
 */
export interface SavedLayout { v: 2; panes: { tabs: TabKey[]; front: PaneKey }[]; fractions: number[]; focus: number }

/**
 * The layout to save: null for one pane; empty panes are left out (their width goes to the others), fewer than two left:
 * null. keepEmpty: a space's view kept while another space is in front keeps them, as they were.
 */
export function serializeLayout(s: Split, keepEmpty = false): SavedLayout | null {
  if (!isSplit(s)) return null;
  const kept = s.panes.map((p, i) => (p.tabs.length === 0 && !keepEmpty ? -1 : i)).filter((i) => i >= 0);
  if (kept.length < 2) return null;
  return {
    v: 2,
    panes: kept.map((i) => ({ tabs: [...s.panes[i]!.tabs], front: s.panes[i]!.front })),
    fractions: normalized(kept.map((i) => s.fractions[i]!), kept.length),
    focus: survivor(kept, s.focus)
  };
}

/** The new index of pane `focus` among the `kept` ones (old indices, ascending): itself, else the nearest on its left, else on its right. */
function survivor(kept: number[], focus: number): number {
  const at = kept.indexOf(focus);
  if (at >= 0) return at;
  const left = kept.filter((i) => i < focus).length;
  return left > 0 ? left - 1 : 0;
}

/** Every key a saved layout names, either version (whatever storage returned); nothing for anything else. */
export function savedKeys(raw: unknown): TabKey[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.panes)) return [];
  if (o.v === 2) return o.panes.every(isPaneRecord) ? (o.panes as { tabs: TabKey[] }[]).flatMap((p) => p.tabs) : [];
  if (o.v === undefined && o.panes.every((k) => typeof k === 'string')) return o.panes as TabKey[];
  return [];
}

/**
 * A saved layout (whatever storage returned) with its keys mapped: v1 panes (one key each) and v2 panes (`{ tabs,
 * front }`); anything else as it is. The same object when it has no panes.
 */
export function mapLayoutKeys(raw: unknown, fn: (k: TabKey) => TabKey): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { panes?: unknown }).panes)) return raw;
  const pane = (p: unknown): unknown => {
    if (typeof p === 'string') return fn(p as TabKey);
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Array.isArray((p as { tabs?: unknown }).tabs)) return p;
    const r = p as { tabs: unknown[]; front?: unknown };
    return { ...r, tabs: r.tabs.map((k) => (typeof k === 'string' ? fn(k as TabKey) : k)), ...(typeof r.front === 'string' ? { front: fn(r.front as TabKey) } : {}) };
  };
  const o = raw as { panes: unknown[] };
  return { ...o, panes: o.panes.map(pane) };
}

/** A saved v2 layout with each pane mapped (`front` null when it names none); any other value as it is. */
export function mapLayoutPanes(raw: unknown, fn: (p: Pane) => Pane): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as { v?: unknown; panes?: unknown };
  if (o.v !== 2 || !Array.isArray(o.panes) || !o.panes.every(isPaneRecord)) return raw;
  return { ...o, panes: (o.panes as { tabs: TabKey[]; front?: unknown }[]).map((p) => fn({ tabs: p.tabs, front: typeof p.front === 'string' ? (p.front as TabKey) : null })) };
}

const isPaneRecord = (p: unknown): p is { tabs: string[]; front?: unknown } =>
  !!p && typeof p === 'object' && !Array.isArray(p) && Array.isArray((p as { tabs?: unknown }).tabs) && (p as { tabs: unknown[] }).tabs.every((k) => typeof k === 'string');

/**
 * A saved layout (whatever storage returned) back into panes, against the tabs open now (`order`).
 * Version 2: each open tab named goes to its pane in the saved order (a key named twice stays in the first); open tabs
 * not named join the focused pane; a pane left without tabs is dropped. Version 1: each open terminal key its own pane,
 * every other open tab with the pane that was focused. At most three panes; fewer than two: null (one pane). Widths
 * that don't add up to 1 are equalized; the focus clamps to a surviving pane (left first). keepEmpty (a space's view
 * coming back): a pane saved empty stays — only one emptied by closes meanwhile is dropped.
 */
export function restoreLayout(raw: unknown, order: TabKey[], keepEmpty = false): Split | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.panes)) return null;
  const open = new Set(order);
  const seen = new Set<TabKey>();
  let named: TabKey[][];
  if (o.v === 2) {
    if (!o.panes.every(isPaneRecord)) return null;
    named = (o.panes as { tabs: string[] }[]).map((p) => p.tabs.filter((k): k is TabKey => {
      if (!open.has(k as TabKey) || seen.has(k as TabKey)) return false;
      seen.add(k as TabKey);
      return true;
    }));
  } else if (o.v === undefined) {
    if (!o.panes.every((k) => typeof k === 'string')) return null;
    const keys = o.panes as string[];
    if (new Set(keys).size !== keys.length) return null;
    named = keys.map((k) => (k.startsWith('t:') && k.length > 2 && open.has(k as TabKey) ? (seen.add(k as TabKey), [k as TabKey]) : []));
  } else return null;
  const fronts = o.v === 2 ? (o.panes as { front?: unknown }[]).map((p) => p.front) : named.map((t) => t[0] ?? null);
  const fr = Array.isArray(o.fractions) && o.fractions.length === named.length && o.fractions.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)
    ? (o.fractions as number[]) : null;
  const sane = fr !== null && Math.abs(fr.reduce((a, b) => a + b, 0) - 1) < 0.01;
  const empty = (i: number) => keepEmpty && o.v === 2 && (o.panes as { tabs: string[] }[])[i]!.tabs.length === 0;
  const kept = named.map((t, i) => (t.length > 0 || empty(i) ? i : -1)).filter((i) => i >= 0).slice(0, MAX_PANES);
  if (kept.length < 2) return null;
  const focusRaw = typeof o.focus === 'number' && Number.isInteger(o.focus) ? Math.min(Math.max(o.focus, 0), named.length - 1) : 0;
  const focus = survivor(kept, focusRaw);
  const inKept = new Set(kept.flatMap((i) => named[i]!));
  const rest = order.filter((k) => !inKept.has(k));
  const sort = byOrder(order);
  const panes: Pane[] = kept.map((i, j) => {
    const own = named[i]!;
    // v1: the focused pane gets the rest in strip order around its terminal; v2: the saved order, the rest after it.
    const tabs = j !== focus ? own : o.v === 2 ? [...own, ...rest] : [...own, ...rest].sort(sort);
    const f = fronts[i];
    return { tabs, front: typeof f === 'string' && own.includes(f as TabKey) ? (f as TabKey) : tabs[0] ?? null };
  });
  return { panes, focus, fractions: sane ? normalized(kept.map((i) => fr[i]!), kept.length) : equal(kept.length) };
}

/** Outside Sessions: the empty pane offers the space's tabs not in front of any pane, in order. */
export function pickableKeys(order: TabKey[], s: Split): TabKey[] {
  const shown = new Set(visibleKeys(s));
  return order.filter((k) => !shown.has(k)).slice(0, PICKER_MAX);
}

/** The picker of an empty pane: sessions and terminals not visible in any pane, pinned first (pin order), then the newest. */
export function pickable(terminals: TerminalInfo[], pins: string[], s: Split): TerminalInfo[] {
  const shown = new Set(visibleKeys(s));
  const free = terminals.filter((x) => !shown.has(`t:${x.id}`));
  const pinned = pins.map((id) => free.find((x) => x.id === id)).filter((x): x is TerminalInfo => !!x);
  const rest = free.filter((x) => !pins.includes(x.id)).sort((a, b) => b.createdAt - a.createdAt);
  return [...pinned, ...rest].slice(0, PICKER_MAX);
}
