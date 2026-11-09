import { MAX_SAVED_TABS, isDbTabKey, type SavedTabs } from '@shared/tabs-state';
import type { TabKey } from './tabs-model';
import { isUntitled } from './untitled';

// Tabs across restarts. Pure: the store applies them.

/**
 * The strip after a restore: the saved order for the file tabs that came back and the terminals and table tabs in the
 * strip (the store adds the restored table tabs first); the tabs it didn't know (new terminals, files opened meanwhile)
 * keep their order after them.
 */
export function mergeOrder(current: TabKey[], saved: string[], restored: ReadonlySet<string>): TabKey[] {
  const live = new Set(current);
  const out: TabKey[] = [];
  for (const k of saved) {
    const key = k as TabKey;
    if (out.includes(key)) continue;
    if (k.startsWith('f:') ? restored.has(k.slice(2)) || live.has(key) : (k.startsWith('t:') || k.startsWith('db:')) && live.has(key)) out.push(key);
  }
  for (const k of current) if (!out.includes(k)) out.push(k);
  return out;
}

/** The tab to bring to the front: the saved one if it is still there (a terminal only needs to be alive). */
export function restoredActive(active: string | null, order: TabKey[], alive: ReadonlySet<string>): TabKey | null {
  if (!active) return null;
  if (active.startsWith('t:')) return alive.has(active.slice(2)) ? (active as TabKey) : null;
  return order.includes(active as TabKey) ? (active as TabKey) : null;
}

/**
 * What a window saves: its file tabs (never untitled ones), terminals and table tabs, in strip order, and the tab in
 * front; with the Shelf's outside files, which main keeps granted.
 */
export function snapshotTabs(order: TabKey[], active: TabKey | null, shelf: string[] = [], dbActive: TabKey | null = null): SavedTabs {
  const keep = (k: string) => k.startsWith('t:') || isDbTabKey(k) || (k.startsWith('f:') && !isUntitled(k.slice(2)));
  const fileKeys = order.filter((k) => k.startsWith('f:') && keep(k));
  // Main keeps MAX_SAVED_TABS files: the first ones, and always the one in front.
  const front = active && fileKeys.includes(active) ? active : null;
  const first = fileKeys.filter((k) => k !== front).slice(0, MAX_SAVED_TABS - (front ? 1 : 0));
  const files = new Set<TabKey>(front ? [...first, front] : first);
  const kept = order.filter((k) => k.startsWith('t:') || isDbTabKey(k) || files.has(k));
  return {
    files: kept.filter((k) => k.startsWith('f:')).map((k) => k.slice(2)),
    order: kept,
    active: active && keep(active) ? active : null,
    ...(shelf.length ? { shelf } : {}),
    // The Databases space's table in front.
    ...(dbActive && isDbTabKey(dbActive) && kept.includes(dbActive) ? { dbActive } : {})
  };
}
