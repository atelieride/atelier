// Spaces: Sessions, Docker, Redis, Databases and Automations, each with its own tabs. The
// activity bar picks the space; the store keeps the active space's view in its usual fields (tabOrder, split, activeTab)
// and the others' here, swapped by switchSpace — as workspaces do inside Sessions. Pure functions.
import { mapLayoutKeys, mapLayoutPanes } from './split';
import { afterClose, type TabKey } from './tabs-model';

/** The sidebar's views, picked in the activity bar (the store re-exports it). */
export type Activity = 'sessions' | 'files' | 'search' | 'services' | 'scm' | 'docker' | 'redis' | 'databases' | 'automations';
export type SpaceId = 'sessions' | 'docker' | 'redis' | 'databases' | 'automations';
export type OtherSpace = Exclude<SpaceId, 'sessions'>;

/** A space's tabs left to right, its tab in front and its split layout (as split.ts saves it; null: one pane). */
export interface SpaceView { order: TabKey[]; front: TabKey | null; layout: unknown }
/** Every space's view; the active space's entry lags (its live view is in the store's fields). */
export type SpaceViews = Record<SpaceId, SpaceView>;

/** The activity that shows each space other than Sessions (Sessions has five: Sessions, Files, Find in Files, Services, Source Control). */
export const SPACE_ACTIVITY: Record<OtherSpace, Activity> = { docker: 'docker', redis: 'redis', databases: 'databases', automations: 'automations' };

export function spaceOf(k: TabKey): SpaceId {
  if (k.startsWith('dk:')) return 'docker';
  if (k.startsWith('rd:')) return 'redis';
  if (k.startsWith('db:')) return 'databases';
  if (k.startsWith('au:')) return 'automations';
  return 'sessions';
}

export function spaceOfActivity(a: Activity): SpaceId {
  return a === 'docker' || a === 'redis' || a === 'databases' || a === 'automations' ? a : 'sessions';
}

const none = (): SpaceView => ({ order: [], front: null, layout: null });
export function emptyViews(): SpaceViews {
  return { sessions: none(), docker: none(), redis: none(), databases: none(), automations: none() };
}

/**
 * Keys closed for good leave every saved view, as a close there would: out of the order; a front
 * that goes passes to the tab used before it (`recent`: that space's activation history, most recent last), else its
 * neighbour — a saved pane's front too. A saved pane keeps its keys: a restore only places open ones.
 */
export function forgetInViews(v: SpaceViews, gone: (k: TabKey) => boolean, recent: (id: SpaceId) => TabKey[] = () => []): SpaceViews {
  const ids = (Object.keys(v) as SpaceId[]).filter((id) => v[id].order.some(gone) || (v[id].front !== null && gone(v[id].front!)));
  if (!ids.length) return v;
  const out = { ...v };
  for (const id of ids) {
    const x = v[id];
    const next = (order: TabKey[], front: TabKey | null) => (front !== null && gone(front) ? afterClose(order, order.filter(gone), front, recent(id)) : front);
    out[id] = { order: x.order.filter((k) => !gone(k)), front: next(x.order, x.front), layout: mapLayoutPanes(x.layout, (p) => ({ ...p, front: next(p.tabs, p.front) })) };
  }
  return out;
}

/** A renamed key (a file moved or saved as) changes in every saved view: order, front and layout. */
export function renameInViews(v: SpaceViews, fn: (k: TabKey) => TabKey): SpaceViews {
  let changed = false;
  const map = (k: TabKey) => { const n = fn(k); if (n !== k) changed = true; return n; };
  const out = {} as SpaceViews;
  for (const id of Object.keys(v) as SpaceId[]) {
    const x = v[id];
    out[id] = { order: x.order.map(map), front: x.front === null ? null : map(x.front), layout: mapLayoutKeys(x.layout, map) };
  }
  return changed ? out : v;
}
