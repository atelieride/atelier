// Tab order: terminals (t:id), files (f:path), files at a commit (rev:oid:rel), tables (db:conn/schema/name), Docker
// targets (dk:), Redis views (rd:) and automations (au:), Services, the
// review, the history and the background (one tab each, their scope chosen in them). Pure functions.
export type TabKey = `t:${string}` | `f:${string}` | `rev:${string}` | `db:${string}` | `dk:${string}` | `rd:${string}` | `au:${string}` | 'services' | 'review' | 'history' | 'background';
export type CloseMode = 'one' | 'others' | 'right' | 'all' | 'files';

/** A tab that can live in a window of its own: every one but an automation's. */
export const canPopOut = (k: TabKey): boolean => !k.startsWith('au:');

/** Aligns the tabs with the live terminals: new ones enter after the active tab (or at the end), vanished ones leave. */
export function syncTerminals(order: TabKey[], ids: string[], active: TabKey | null): TabKey[] {
  const alive = new Set(ids);
  const kept = order.filter((k) => !k.startsWith('t:') || alive.has(k.slice(2)));
  const present = new Set(kept);
  const fresh = ids.map((id) => `t:${id}` as TabKey).filter((k) => !present.has(k));
  if (kept.length === order.length && fresh.length === 0) return order;
  const at = active ? kept.indexOf(active) : -1;
  return at >= 0 ? [...kept.slice(0, at + 1), ...fresh, ...kept.slice(at + 1)] : [...kept, ...fresh];
}

/** The tabs a close command applies to ("files" = files only). */
export function closingKeys(order: TabKey[], key: TabKey, mode: CloseMode): TabKey[] {
  const i = order.indexOf(key);
  if (i === -1) return [];
  switch (mode) {
    case 'one': return [key];
    case 'others': return order.filter((k) => k !== key);
    case 'right': return order.slice(i + 1);
    case 'all': return [...order];
    case 'files': return order.filter((k) => k.startsWith('f:'));
  }
}

/** Tabs remembered in the activation history. */
export const RECENT_TABS = 50;

/** The activation history (most recent last) after `key` became active. */
export function noteActive(recent: TabKey[], key: TabKey): TabKey[] {
  if (recent.at(-1) === key) return recent;
  return [...recent.filter((k) => k !== key), key].slice(-RECENT_TABS);
}

/**
 * The active tab after a close: it stays if it is not closing; otherwise the tab used most recently before it (an
 * opened file goes back to where it was opened from), then the nearest one to the right, then to the left.
 */
export function afterClose(order: TabKey[], closing: TabKey[], active: TabKey | null, recent: TabKey[] = []): TabKey | null {
  const gone = new Set(closing);
  if (active && !gone.has(active) && order.includes(active)) return active;
  for (let j = recent.length - 1; j >= 0; j--) {
    const k = recent[j]!;
    if (k !== active && !gone.has(k) && order.includes(k)) return k;
  }
  const i = active ? order.indexOf(active) : -1;
  for (let j = i + 1; j < order.length; j++) if (!gone.has(order[j]!)) return order[j]!;
  for (let j = Math.min(i, order.length) - 1; j >= 0; j--) if (!gone.has(order[j]!)) return order[j]!;
  return order.find((k) => !gone.has(k)) ?? null;
}

/** Moves a tab before another one (null = to the end). */
export function moveTab(order: TabKey[], key: TabKey, before: TabKey | null): TabKey[] {
  if (key === before || !order.includes(key)) return order;
  const rest = order.filter((k) => k !== key);
  const at = before ? rest.indexOf(before) : -1;
  return at >= 0 ? [...rest.slice(0, at), key, ...rest.slice(at)] : [...rest, key];
}

export function cycle(order: TabKey[], active: TabKey | null, dir: 1 | -1): TabKey | null {
  if (order.length === 0) return null;
  const i = active ? order.indexOf(active) : -1;
  if (i === -1) return dir === 1 ? order[0]! : order.at(-1)!;
  return order[(i + dir + order.length) % order.length] ?? null;
}

/** ⌘1…⌘8: the nth tab; ⌘9: the last one. */
export function nth(order: TabKey[], n: number): TabKey | null {
  if (order.length === 0) return null;
  return n >= 9 ? order.at(-1)! : order[n - 1] ?? null;
}

/** Where a dragged tab lands: before the tab under the mouse, or after it if on its right half (null = at the end). */
export function dropTarget(order: TabKey[], over: TabKey, rect: { left: number; width: number }, x: number): TabKey | null {
  if (x < rect.left + rect.width / 2) return over;
  const i = order.indexOf(over);
  return i >= 0 ? order[i + 1] ?? null : over;
}

/**
 * Where an opened file goes, with preview tabs (at most one, replaced by the next file opened the same
 * way). An already open tab is only activated; opening the preview file as a normal tab (double click) promotes it.
 */
export function openTab(order: TabKey[], key: TabKey, active: TabKey | null, preview: TabKey | null, asPreview: boolean): { order: TabKey[]; preview: TabKey | null; replaced: TabKey | null } {
  const live = preview && order.includes(preview) ? preview : null;
  if (order.includes(key)) return { order, preview: key === live && !asPreview ? null : live, replaced: null };
  if (asPreview && live) return { order: order.map((k) => (k === live ? key : k)), preview: key, replaced: live };
  const i = active ? order.indexOf(active) : -1;
  const next = i >= 0 ? [...order.slice(0, i + 1), key, ...order.slice(i + 1)] : [...order, key];
  return { order: next, preview: asPreview ? key : live, replaced: null };
}
