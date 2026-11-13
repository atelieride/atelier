// Workspaces: groups of a project's terminals and file tabs, each with its own tab order,
// tab in front and split layout. The store keeps the active workspace's view in its usual fields (tabOrder, split…)
// and swaps it with these entries; this module is the pure model. A terminal belongs to exactly one workspace
// (`members`); a file may be open in several (its key in their orders); the project views belong to none.
import type { TerminalInfo } from '@shared/protocol';
import { isAbsPath } from '@shared/paths';
import type { TabKey } from './tabs-model';
import { mapLayoutKeys } from './split';
import { spaceOf } from './spaces';
import { inboxSection } from './inbox';
import { t } from './i18n/en';

export const MAX_WORKSPACES = 20;
/** Activities one workspace may hold. */
export const MAX_ACTIVITIES = 20;
export const MAX_NAME = 60;
/** Workspace colors are tokens `--ws-1…--ws-8` (theme.css). */
export const WS_COLORS = 8;
/** Key lengths a saved state may hold (a revision key carries a commit id and a relative path). */
const MAX_KEY = 4200;

export interface Workspace {
  id: string;
  name: string;
  /** 1…WS_COLORS. */
  color: number;
  /** Where its new sessions and terminals start (an existing folder or worktree); null: the project root. */
  folder: string | null;
  /** Its tabs left to right, project views never among them. Kept current only while it is not the active one. */
  order: TabKey[];
  /** Its tab in front (never a project view). */
  active: TabKey | null;
  /** Its split layout as split.ts saves it (validated when restored), or null for one pane. */
  layout: unknown;
  /**
   * Open or folded in the sidebar, as its chevron last left it. Unset: open while it is the
   * active one. Coming to the front clears it; leaving the front writes what it showed.
   */
  open?: boolean;
  /**
   * Set on an activity: the workspace it sits in. An activity is a place with its own tabs inside that workspace; it
   * wears the workspace's color and starts things in its folder. Activities never hold activities.
   */
  parent?: string;
  /** On a workspace: the activity that was in front when it was left (unset: its own tabs). */
  place?: string;
}

export interface WorkspacesState {
  /** Off: one strip as before; everything here is kept for when it is turned on again. */
  on: boolean;
  /** The place in front: a workspace (its own tabs) or one of its activities. */
  active: string;
  /** Workspaces and activities, in the order they were made or moved (activities have a `parent`). */
  list: Workspace[];
  /** Terminal id → place id (a workspace or an activity). */
  members: Record<string, string>;
  /**
   * Activities kept aside while activities are turned off: the entries and their terminals' places. Their tabs live in
   * their workspaces meanwhile; turning activities on again brings them back.
   */
  parked?: { list: Workspace[]; members: Record<string, string> };
  /**
   * On only because Settings turns workspaces on in every project (2026-11-02): the project's own switch is off, and
   * they go back off when that setting does. Only with `on`.
   */
  forced?: true;
}

export type DotKind = 'waiting' | 'working' | 'done' | 'resume';
export interface Dot { kind: DotKind; n: number }

/** Sessions' project views (Docker, Redis, Databases and Automations have spaces of their own). */
export const PROJECT_KEYS: readonly TabKey[] = ['services', 'review', 'history', 'background'];
const projectSet = new Set<string>(PROJECT_KEYS);
export const isProjectKey = (k: TabKey): boolean => projectSet.has(k);
/** A key a workspace holds: Sessions', not one of its project views. */
export const workspaceKey = (k: TabKey): boolean => spaceOf(k) === 'sessions' && !isProjectKey(k);
const own = workspaceKey;

/** The order with the project views at the end (both parts keep their order); the same array when already so. */
export function projectLast(order: TabKey[]): TabKey[] {
  const first = order.findIndex(isProjectKey);
  if (first === -1 || order.slice(first).every(isProjectKey)) return order;
  return [...order.filter((x) => !isProjectKey(x)), ...order.filter(isProjectKey)];
}

let seq = 0;
/** A new workspace id, unique in this window's lifetime and across restarts. */
export function newWorkspaceId(): string {
  return `w${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** An activity: a place inside a workspace (an entry with a parent). */
export const isWsActivity = (w: Workspace): boolean => w.parent !== undefined;

/** The workspaces themselves, in list order (the sidebar's groups, Go, ⌥⌘1…9, the limits): no activity. */
export function workspacesOf(s: Pick<WorkspacesState, 'list'>): Workspace[] {
  return s.list.filter((w) => !isWsActivity(w));
}

/** Workspace `wsId`'s activities, in list order (the order they were made in). */
export function activitiesOf(s: Pick<WorkspacesState, 'list'>, wsId: string): Workspace[] {
  return s.list.filter((w) => w.parent === wsId);
}

/** The workspace a place belongs to: an activity's parent, a workspace (or an unknown id) itself. */
export function workspaceOf(s: Pick<WorkspacesState, 'list'>, placeId: string): string {
  return s.list.find((w) => w.id === placeId)?.parent ?? placeId;
}

/** Every place in the sidebar's order: each workspace, then its activities. */
export function placesInOrder(s: Pick<WorkspacesState, 'list'>): Workspace[] {
  return workspacesOf(s).flatMap((w) => [w, ...activitiesOf(s, w.id)]);
}

/** Where a way back to workspace `wsId` lands: the activity it was left at while that still exists, else its own tabs. */
export function placeOnReturn(s: Pick<WorkspacesState, 'list'>, wsId: string): string {
  const p = s.list.find((w) => w.id === wsId)?.place;
  return p && s.list.some((w) => w.id === p && w.parent === wsId) ? p : wsId;
}

const tidy = (name: string) => name.trim().slice(0, MAX_NAME);
const inRange = (c: number) => (Number.isInteger(c) && c >= 1 && c <= WS_COLORS ? c : 1);
const termId = (k: TabKey) => (k.startsWith('t:') ? k.slice(2) : null);
const without = <T>(xs: T[], x: T) => xs.filter((y) => y !== x);

/** Turning workspaces on for the first time: one workspace with every tab but the project views, every live terminal. */
export function initial(id: string, order: TabKey[], active: TabKey | null, terminalIds: string[]): WorkspacesState {
  return {
    on: true, active: id,
    list: [{ id, name: 'Workspace 1', color: 1, folder: null, order: order.filter(own), active: active && own(active) ? active : null, layout: null }],
    members: Object.fromEntries(terminalIds.map((t) => [t, id]))
  };
}

/** The first color no workspace uses, else round again. */
export function nextColor(list: Workspace[]): number {
  const used = new Set(list.map((w) => w.color));
  for (let c = 1; c <= WS_COLORS; c++) if (!used.has(c)) return c;
  return (list.length % WS_COLORS) + 1;
}

/** A new workspace at the end (null: empty name, or the limit reached). The active one doesn't change. */
export function create(s: WorkspacesState, opts: { name: string; color?: number; folder?: string | null }, id = newWorkspaceId()): WorkspacesState | null {
  const name = tidy(opts.name);
  const wss = workspacesOf(s);
  if (!name || wss.length >= MAX_WORKSPACES || s.list.some((w) => w.id === id)) return null;
  const w: Workspace = { id, name, color: opts.color ? inRange(opts.color) : nextColor(wss), folder: opts.folder ?? null, order: [], active: null, layout: null };
  return { ...s, list: [...s.list, w] };
}

/**
 * A new activity in workspace `wsId`, last among its activities and folded, in its color, empty (null: `wsId` is no
 * workspace, it holds MAX_ACTIVITIES already, or the id is taken). An empty name gives the default one. The place in
 * front doesn't change.
 */
export function createWsActivity(s: WorkspacesState, wsId: string, name: string, id = newWorkspaceId()): WorkspacesState | null {
  const ws = s.list.find((w) => w.id === wsId);
  if (!ws || isWsActivity(ws) || activitiesOf(s, wsId).length >= MAX_ACTIVITIES || s.list.some((w) => w.id === id)) return null;
  const a: Workspace = { id, parent: wsId, name: tidy(name) || t.wsAct.defaultName, color: ws.color, folder: null, order: [], active: null, layout: null };
  return { ...s, list: [...s.list, a] };
}

function patch(s: WorkspacesState, id: string, fn: (w: Workspace) => Workspace): WorkspacesState {
  return { ...s, list: s.list.map((w) => (w.id === id ? fn(w) : w)) };
}

/** The entry without its `place` (its own tabs are where a way back lands). */
function noPlace(w: Workspace): Workspace {
  if (!('place' in w)) return w;
  const { place: _, ...rest } = w;
  return rest;
}

export function rename(s: WorkspacesState, id: string, name: string): WorkspacesState {
  const n = tidy(name);
  return n ? patch(s, id, (w) => ({ ...w, name: n })) : s;
}

/** A workspace's color, worn by its activities too. */
export function recolor(s: WorkspacesState, id: string, color: number): WorkspacesState {
  const c = inRange(color);
  return { ...s, list: s.list.map((w) => (w.id === id || w.parent === id ? { ...w, color: c } : w)) };
}

/**
 * Whether entry `id` shows its rows in the sidebar: its chevron's choice, else — a workspace — whether it (one of its
 * places) is in front. An activity is folded until its chevron opens it: being in front never opens it.
 */
export function isOpen(s: WorkspacesState, id: string): boolean {
  const w = s.list.find((x) => x.id === id);
  if (w && isWsActivity(w)) return w.open ?? false;
  return w?.open ?? workspaceOf(s, s.active) === id;
}

/** The chevron: folds an open workspace or opens a folded one, an explicit choice kept until it comes to the front. */
export function toggleOpen(s: WorkspacesState, id: string): WorkspacesState {
  if (!s.list.some((w) => w.id === id)) return s;
  const open = !isOpen(s, id);
  return patch(s, id, (w) => ({ ...w, open }));
}

/**
 * Place `id` comes to the front (revised 2026-11-08). Into another workspace: that workspace's
 * chevron choice goes (it opens), and the one it replaces keeps showing what it showed — open stays open, folded stays
 * folded — so only a chevron ever folds. Between places of one workspace nothing folds or opens, and an activity's own
 * fold is never touched. The workspace records the place it is at (`place`: an activity; unset: its own tabs).
 * The same state for the place already in front or an unknown id.
 */
export function toFront(s: WorkspacesState, id: string): WorkspacesState {
  if (id === s.active || !s.list.some((w) => w.id === id)) return s;
  const toWs = workspaceOf(s, id);
  const fromWs = workspaceOf(s, s.active);
  const cross = toWs !== fromWs;
  const leftOpen = isOpen(s, fromWs);
  const list = s.list.map((w) => {
    if (w.id === toWs) {
      let n = w;
      if (cross) { const { open: _, ...rest } = n; n = rest; }
      if (id !== toWs) n = { ...n, place: id };
      else if ('place' in n) { const { place: _p, ...rest } = n; n = rest; }
      return n;
    }
    return cross && w.id === fromWs ? { ...w, open: leftOpen } : w;
  });
  return { ...s, active: id, list };
}

/**
 * Swaps a workspace with its neighbouring workspace (-1 up, +1 down); the activities between them keep their places.
 * At an end, or for an activity, the same state.
 */
export function reorder(s: WorkspacesState, id: string, dir: -1 | 1): WorkspacesState {
  const i = s.list.findIndex((w) => w.id === id && !isWsActivity(w));
  let j = i + dir;
  while (i !== -1 && j >= 0 && j < s.list.length && isWsActivity(s.list[j]!)) j += dir;
  if (i === -1 || j < 0 || j >= s.list.length) return s;
  const list = [...s.list];
  [list[i], list[j]] = [list[j]!, list[i]!];
  return { ...s, list };
}

/** Terminals with no workspace join `wsId`; one that has a workspace never moves. The same state if none is new. */
export function assign(s: WorkspacesState, ids: string[], wsId: string): WorkspacesState {
  const fresh = ids.filter((id) => !(id in s.members));
  if (!fresh.length) return s;
  return { ...s, members: { ...s.members, ...Object.fromEntries(fresh.map((id) => [id, wsId])) } };
}

/** A terminal's workspace: its own, or (unknown, or its workspace gone) the active one. */
export function memberOf(s: WorkspacesState, terminalId: string): string {
  const m = s.members[terminalId];
  return m && s.list.some((w) => w.id === m) ? m : s.active;
}

/** A resumed session's new id keeps its workspace and its place. */
export function relink(s: WorkspacesState, from: string, to: string): WorkspacesState {
  if (!(from in s.members) || from === to) return s;
  const { [from]: ws, ...rest } = s.members;
  const a = `t:${from}` as TabKey;
  const b = `t:${to}` as TabKey;
  return {
    ...s,
    members: { ...rest, [to]: ws! },
    list: s.list.map((w) => (w.order.includes(a) || w.active === a ? { ...w, order: w.order.map((x) => (x === a ? b : x)), active: w.active === a ? b : w.active } : w))
  };
}

/**
 * A file renamed or moved (or an untitled tab saved as a file): its key changes in every workspace — order, tab in
 * front, split layout. The same state when no key changes.
 */
export function renameKeys(s: WorkspacesState, fn: (k: TabKey) => TabKey): WorkspacesState {
  let changed = false;
  const map = (k: TabKey) => { const n = fn(k); if (n !== k) changed = true; return n; };
  // A layout's panes: v1 one key each, v2 `{ tabs, front }`; anything else as it is.
  const list = s.list.map((w) => ({ ...w, order: w.order.map(map), active: w.active ? map(w.active) : null, layout: mapLayoutKeys(w.layout, map) }));
  return changed ? { ...s, list } : s;
}

/**
 * Tabs closed for good (the table tabs of a removed connection, Settings › Databases › Never): out of every workspace's
 * order and front, so no switch brings them back. The same state when no workspace holds one.
 */
export function forget(s: WorkspacesState, gone: (k: TabKey) => boolean): WorkspacesState {
  if (!s.list.some((w) => w.order.some(gone) || (w.active !== null && gone(w.active)))) return s;
  return { ...s, list: s.list.map((w) => ({ ...w, order: w.order.filter((k) => !gone(k)), active: w.active !== null && gone(w.active) ? null : w.active })) };
}

/** Memberships of terminals not in `keep` (neither running nor resumable) go; the same state if none does. */
export function prune(s: WorkspacesState, keep: Iterable<string>): WorkspacesState {
  const k = new Set(keep);
  const ids = Object.keys(s.members);
  if (ids.every((id) => k.has(id))) return s;
  return { ...s, members: Object.fromEntries(ids.filter((id) => k.has(id)).map((id) => [id, s.members[id]!])) };
}

/**
 * A tab moves to workspace `to`: a terminal changes membership and order; a file leaves workspace `from` (the active
 * one unless said) — other workspaces showing it keep it — and joins the target once. For the active workspace the
 * store applies the same change to its live order.
 */
export function moveKey(s: WorkspacesState, key: TabKey, to: string, from: string = s.active): WorkspacesState {
  const id = termId(key);
  const source = id ? memberOf(s, id) : from;
  const list = s.list.map((w) => {
    if (w.id === to) return w.order.includes(key) ? w : { ...w, order: [...w.order, key] };
    if (w.id !== source) return w;
    return { ...w, order: without(w.order, key), active: w.active === key ? null : w.active };
  });
  return { ...s, list, members: id ? { ...s.members, [id]: to } : s.members };
}

/**
 * Activity `id` goes to workspace `toWs` with everything in it (its terminals keep pointing at it), last among that
 * workspace's activities, in its color. The same state when `toWs` is no workspace, is its own, or is full, or `id` is
 * no activity. The workspace it left forgets it as the place it was left at.
 */
export function moveWsActivity(s: WorkspacesState, id: string, toWs: string): WorkspacesState {
  const a = s.list.find((w) => w.id === id);
  const to = s.list.find((w) => w.id === toWs);
  if (!a || !isWsActivity(a) || !to || isWsActivity(to) || a.parent === toWs || activitiesOf(s, toWs).length >= MAX_ACTIVITIES) return s;
  const list = s.list.filter((w) => w.id !== id).map((w) => (w.id === a.parent && w.place === id ? noPlace(w) : w));
  return { ...s, list: [...list, { ...a, parent: toWs, color: to.color }] };
}

/**
 * Closing activity `id`. move: its terminals and tabs join its workspace's own tabs (keys not there yet); stop: its
 * terminals' memberships go (the store stops them). In front, its workspace's own tabs come forward. The same state
 * for anything but an activity.
 */
export function removeWsActivity(s: WorkspacesState, id: string, how: 'move' | 'stop'): WorkspacesState {
  const a = s.list.find((w) => w.id === id);
  if (!a || !isWsActivity(a)) return s;
  const wsId = a.parent!;
  const members = how === 'move'
    ? Object.fromEntries(Object.entries(s.members).map(([tid, p]) => [tid, p === id ? wsId : p]))
    : Object.fromEntries(Object.entries(s.members).filter(([, p]) => p !== id));
  const list = s.list.filter((w) => w.id !== id).map((w) => {
    if (w.id !== wsId) return w;
    const n = how === 'move' ? { ...w, order: [...w.order, ...a.order.filter((x) => !w.order.includes(x))] } : w;
    return n.place === id ? noPlace(n) : n;
  });
  return { ...s, list, members, active: s.active === id ? wsId : s.active };
}

/**
 * Closing workspace `id` (null: it is the last one). moveTo: its terminals join that workspace (membership and order)
 * and its activities go there as activities, folded — past MAX_ACTIVITIES the extra ones' terminals and tabs join its
 * own tabs instead; null: everything in it stops, the memberships go. Its own files close (the store drops those no
 * other place shows). One of its places in front: the target (or the next workspace) comes forward.
 */
export function remove(s: WorkspacesState, id: string, moveTo: string | null): WorkspacesState | null {
  const wss = workspacesOf(s);
  const i = wss.findIndex((w) => w.id === id);
  if (i === -1 || wss.length <= 1) return null;
  const gone = wss[i]!;
  const target = moveTo && moveTo !== id && wss.some((w) => w.id === moveTo) ? moveTo : null;
  const acts = activitiesOf(s, id);
  const room = target ? Math.max(0, MAX_ACTIVITIES - activitiesOf(s, target).length) : 0;
  const kept = target ? acts.slice(0, room) : [];
  const flat = target ? acts.slice(room) : [];
  const flatIds = new Set(flat.map((w) => w.id));
  const places = new Set([id, ...acts.map((w) => w.id)]);
  const color = target ? wss.find((w) => w.id === target)!.color : 1;
  const extra = [...new Set([...gone.order.filter((x) => x.startsWith('t:')), ...flat.flatMap((w) => w.order)])];
  const list = [
    ...s.list.filter((w) => !places.has(w.id)).map((w) => (w.id === target ? { ...w, order: [...w.order, ...extra.filter((x) => !w.order.includes(x))] } : w)),
    ...kept.map((w) => ({ ...w, parent: target!, color, open: false }))
  ];
  const members = Object.fromEntries(Object.entries(s.members).flatMap(([tid, p]): [string, string][] => {
    if (!places.has(p)) return [[tid, p]];
    if (!target) return [];
    return [[tid, p === id || flatIds.has(p) ? target : p]];
  }));
  const left = workspacesOf({ list });
  const active = !places.has(s.active) ? s.active : target ?? (left[Math.min(i, left.length - 1)] ?? left[0]!).id;
  return { ...s, list, members, active };
}

/** The active workspace's entry takes its live view: its order (project views out), its tab in front, its layout. */
export function withView(s: WorkspacesState, liveOrder: TabKey[], liveActive: TabKey | null, layout: unknown): WorkspacesState {
  return patch(s, s.active, (w) => ({ ...w, order: liveOrder.filter(own), active: liveActive && own(liveActive) ? liveActive : null, layout }));
}

/** What workspace `id` shows: its keys that still live (its own terminals only), its front if it lives, its layout. */
export function viewOf(s: WorkspacesState, id: string, alive: (k: TabKey) => boolean): { order: TabKey[]; active: TabKey | null; layout: unknown } {
  const w = s.list.find((x) => x.id === id);
  if (!w) return { order: [], active: null, layout: null };
  const mine = (k: TabKey) => { const t = termId(k); return t === null || memberOf(s, t) === id; };
  const order = w.order.filter((k) => own(k) && mine(k) && alive(k));
  return { order, active: w.active && order.includes(w.active) ? w.active : null, layout: w.layout };
}

/**
 * Every workspace's tabs in workspace order (the active one's live order in its place), then the live project views:
 * one strip for "off", and what tabs.json saves. A file in several workspaces comes once, where it first is.
 */
export function union(s: WorkspacesState, liveOrder: TabKey[]): TabKey[] {
  const seen = new Set<TabKey>();
  const out: TabKey[] = [];
  for (const w of s.list) {
    const keys = w.id === s.active ? liveOrder.filter(own) : w.order.filter(own);
    for (const x of keys) if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return [...out, ...liveOrder.filter(isProjectKey)];
}

/**
 * Every live key belongs somewhere (turning on again, after a restore): a terminal joins its workspace's order (one
 * without a workspace joins the active one), a file no workspace holds joins the active one. Nothing is removed.
 */
export function absorb(s: WorkspacesState, liveOrder: TabKey[]): WorkspacesState {
  const held = new Set<TabKey>(s.list.flatMap((w) => w.order));
  const adds = new Map<string, TabKey[]>();
  let members = s.members;
  for (const k of liveOrder) {
    if (!own(k)) continue;
    const id = termId(k);
    if (id) {
      if (!(id in members) || !s.list.some((w) => w.id === members[id])) members = { ...members, [id]: s.active };
      const ws = s.list.find((w) => w.id === members[id])!;
      if (!ws.order.includes(k)) adds.set(ws.id, [...(adds.get(ws.id) ?? []), k]);
    } else if (!held.has(k)) adds.set(s.active, [...(adds.get(s.active) ?? []), k]);
  }
  if (!adds.size && members === s.members) return s;
  return { ...s, members, list: s.list.map((w) => (adds.has(w.id) ? { ...w, order: [...w.order, ...adds.get(w.id)!] } : w)) };
}

/** A card's state dots: one per state present (needs you, working, finished and not seen), then those to resume. */
export function dots(terminals: TerminalInfo[], toResume: number): Dot[] {
  const n = { waiting: 0, working: 0, done: 0 };
  for (const x of terminals) {
    const sec = inboxSection(x);
    if (sec === 'needs') n.waiting++;
    else if (sec === 'working') n.working++;
    else if (sec === 'review') n.done++;
  }
  const out: Dot[] = [];
  for (const kind of ['waiting', 'working', 'done'] as const) if (n[kind]) out.push({ kind, n: n[kind] });
  if (toResume) out.push({ kind: 'resume', n: toResume });
  return out;
}

// ---- reading a saved state (localStorage: anything may be there) ----

const ID = /^[\w-]{1,40}$/;
const TERM = /^[\w.-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function okKey(v: unknown): v is TabKey {
  if (typeof v !== 'string' || v.length > MAX_KEY) return false;
  if (v.startsWith('t:')) return TERM.test(v.slice(2));
  if (v.startsWith('f:')) return isAbsPath(v.slice(2));
  // Table tabs an older version saved here live in Databases now: tabs.json brings them back.
  return v.startsWith('rev:') && v.length > 4;
}

function parseOne(v: unknown): Workspace | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID.test(v.id)) return null;
  const name = typeof v.name === 'string' ? tidy(v.name) : '';
  const order = Array.isArray(v.order) ? [...new Set(v.order.filter(okKey))] : [];
  const active = okKey(v.active) && order.includes(v.active) ? v.active : null;
  return {
    id: v.id, name: name || 'Workspace', color: typeof v.color === 'number' ? inRange(v.color) : 1,
    folder: typeof v.folder === 'string' && isAbsPath(v.folder) ? v.folder : null,
    order, active, layout: isObj(v.layout) ? v.layout : null,
    ...(typeof v.open === 'boolean' ? { open: v.open } : {})
  };
}

/** A saved state read field by field (junk entries dropped, never the whole state); null if it holds no workspace. */
export function parseWorkspaces(raw: unknown): WorkspacesState | null {
  if (!isObj(raw) || !Array.isArray(raw.list)) return null;
  const list: Workspace[] = [];
  for (const v of raw.list) {
    const w = parseOne(v);
    if (w && !list.some((x) => x.id === w.id) && list.length < MAX_WORKSPACES) list.push(w);
  }
  if (!list.length) return null;
  const ids = new Set(list.map((w) => w.id));
  const members = isObj(raw.members)
    ? Object.fromEntries(Object.entries(raw.members).filter(([t, w]) => TERM.test(t) && typeof w === 'string' && ids.has(w)) as [string, string][])
    : {};
  const active = typeof raw.active === 'string' && ids.has(raw.active) ? raw.active : list[0]!.id;
  return { on: raw.on === true, active, list, members, ...(raw.on === true && raw.forced === true ? { forced: true as const } : {}) };
}
