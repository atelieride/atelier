// The record view's model (Tab on a row): its keys, the row it
// shows, where ↑/↓ go, when it asks for the next fetch, and the tab state it keeps — `view` and `record` (DbTabState),
// changed only through patchTab (the tab's state is read-only). Which element takes the keyboard after a key opened or
// closed it is told once (takeKeys): a click on the toolbar's toggle keeps the keyboard on the toggle. RecordView.tsx
// draws it; Grid.tsx's Tab and the toolbar open it. Lazy, with the table's chunk.
import { useDb, type DbTabState } from './store';

/** What a key does in the record view: the previous or next row, or back to the grid. */
export type RecordKeyAction = 'prev' | 'next' | 'back';

/**
 * The record view's keys (its own element's: no window listener): ↑/↓ the previous and next row, Tab or Esc back to the
 * grid. Shift+Tab moves the focus as the browser does (nothing trapped); ⇧↑/⇧↓ extend a text selection; PageUp,
 * PageDown, Home, End and Space scroll the record; chords are someone else's. `typing`: the key went to a field, which
 * keeps every key.
 */
export function recordKey(k: { key: string; shift: boolean; mod: boolean; alt: boolean; ctrl: boolean }, typing: boolean): RecordKeyAction | null {
  if (typing || k.mod || k.alt || k.ctrl) return null;
  if (k.key === 'Tab') return k.shift ? null : 'back';
  if (k.shift) return null;
  if (k.key === 'Escape') return 'back';
  if (k.key === 'ArrowUp') return 'prev';
  if (k.key === 'ArrowDown') return 'next';
  return null;
}

/** Whether a key's target is a place to type in (a field keeps its keys). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

const within = (i: number, n: number): number => Math.max(0, Math.min(n - 1, i));

/**
 * The row the record view shows: its index (none kept: the first) within the rows loaded — a new first page with fewer
 * rows (a filter, a Refresh) shows its last; null without rows.
 */
export function recordRow(st: Pick<DbTabState, 'record' | 'rows'>): number | null {
  return st.rows.length === 0 ? null : within(st.record ?? 0, st.rows.length);
}

/**
 * The row the toolbar's Record opens on: the focused row, else the last one selected, else the first wholly on screen
 * (`onScreen`, the grid's scroll) — within the rows loaded; 0 without rows (the view shows them once they come).
 */
export function openRow(st: Pick<DbTabState, 'focus' | 'selection' | 'rows'>, onScreen: number): number {
  const n = st.rows.length;
  if (n === 0) return 0;
  return within(st.focus?.row ?? st.selection[st.selection.length - 1] ?? onScreen, n);
}

/** ↑/↓: the row before or after the one shown; null at either end (it stays: the next fetch comes by itself, wantsMore). */
export function stepRow(st: Pick<DbTabState, 'record' | 'rows'>, d: 1 | -1): number | null {
  const at = recordRow(st);
  if (at === null) return null;
  const to = at + d;
  return to < 0 || to >= st.rows.length ? null : to;
}

/**
 * Whether the record view asks for the next fetch: it shows the last row loaded and the next fetch is idle — as the grid
 * near its end; never after an error (Retry is theirs, in the grid's last row), nor at the end or the cap.
 */
export function wantsMore(index: number | null, count: number, more: DbTabState['more']): boolean {
  return index !== null && index === count - 1 && more === 'idle';
}

// ---------- the tab's state ----------

const patch = (key: string, p: Partial<DbTabState>) => useDb.getState().patchTab(key, p);

/** Who takes the keyboard after a key changed the view, per tab: read once (takeKeys). */
const keysTo = new Map<string, 'record' | 'grid'>();

/** Whether `where` takes the keyboard now (asked by the key that opened or closed the record view); told once. */
export function takeKeys(key: string, where: 'record' | 'grid'): boolean {
  if (keysTo.get(key) !== where) return false;
  keysTo.delete(key);
  return true;
}

/**
 * The record view on row `row` (Tab on a grid row, the toolbar's Record). The grid's selection and focus stay as they
 * are until it comes back. `keys`: the record view takes the keyboard (the key that opened it was the grid's).
 */
export function openRecord(key: string, row: number, keys = false): void {
  if (keys) keysTo.set(key, 'record');
  else keysTo.delete(key);
  patch(key, { view: 'record', record: row });
}

/** ↑/↓ in the record view: the record moves (the grid follows when it comes back); at an end it stays. */
export function moveRecord(key: string, d: 1 | -1): void {
  const to = stepRow(useDb.getState().tab(key), d);
  if (to !== null) patch(key, { record: to });
}

/**
 * Back to the grid (Tab or Esc in the record view, the toolbar's Grid): the record's row focused — in the column focused
 * before, else the first one shown — and selected alone; the grid brings it into view if it isn't. `keys`: the grid
 * takes the keyboard.
 */
export function closeRecord(key: string, keys = false): void {
  const st = useDb.getState().tab(key);
  const row = recordRow(st);
  if (keys) keysTo.set(key, 'grid');
  else keysTo.delete(key);
  if (row === null) {
    patch(key, { view: 'grid', selection: [], focus: null });
    return;
  }
  const first = st.data ? st.data.columns.findIndex((c) => !st.data!.hidden.includes(c.name)) : 0;
  patch(key, { view: 'grid', selection: [row], focus: { row, col: st.focus?.col ?? Math.max(0, first) } });
}
