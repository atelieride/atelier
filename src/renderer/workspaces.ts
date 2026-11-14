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
   * wears a color of its own (its band and glyph part it from its neighbours) and starts things in the workspace's
   * folder. Activities never hold activities.
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
  parked?: Parked;
  /**
   * On only because Settings turns workspaces on in every project (2026-11-02): the project's own switch is off, and
   * they go back off when that setting does. Only with `on`.
   */
  forced?: true;
  /**
   * Its activities wear colors of their own, chosen or picked by activityColor. Unset on a state saved while every
   * activity wore its workspace's color: reading it gives each activity still wearing that color one of its own, once
   * (an activity later set to its workspace's color on purpose keeps it).
   */
  ownColors?: true;
}

/** Activities kept aside while activities are off. */
export interface Parked {
  /** The activities, as they were (their tabs, tab in front, split, fold). */
  list: Workspace[];
  /** Terminal id → the activity it was in. */
  members: Record<string, string>;
  /** Workspace id → the keys parking added to its own tabs (taken back out when the activities return). */
  joined: Record<string, TabKey[]>;
  /**
   * Workspace id → its own tab in front and split, for a workspace that was left at an activity: parking gave it that
   * activity's, and the activities' return gives its own back.
   */
  own?: Record<string, { active: TabKey | null; layout: unknown }>;
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
    members: Object.fromEntries(terminalIds.map((t) => [t, id])), ownColors: true
  };
}

/** The first color no workspace uses, else round again. */
export function nextColor(list: Workspace[]): number {
  const used = new Set(list.map((w) => w.color));
  for (let c = 1; c <= WS_COLORS; c++) if (!used.has(c)) return c;
  return (list.length % WS_COLORS) + 1;
}

/**
 * A new activity's color, so it parts from its neighbours: one nothing wears yet; else one no workspace and no sibling
 * wears (it never reads as another workspace's); else one its workspace and siblings don't wear; else round again.
 * The search starts after the workspace's own color.
 */
function activityColor(s: WorkspacesState, ws: Workspace): number {
  const near = new Set([ws, ...activitiesOf(s, ws.id)].map((w) => w.color));
  const heads = new Set(workspacesOf(s).map((w) => w.color));
  const all = new Set(s.list.map((w) => w.color));
  const after = Array.from({ length: WS_COLORS - 1 }, (_, k) => ((ws.color + k) % WS_COLORS) + 1);
  const free = after.find((c) => !all.has(c)) ?? after.find((c) => !near.has(c) && !heads.has(c)) ?? after.find((c) => !near.has(c));
  if (free) return free;
  return nextColor([ws, ...activitiesOf(s, ws.id)]);
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
 * A new activity in workspace `wsId`, last among its activities and folded, in a color of its own (activityColor),
 * empty (null: `wsId` is no workspace, it holds MAX_ACTIVITIES already, or the id is taken). An empty name gives the
 * default one. The place in front doesn't change.
 */
export function createWsActivity(s: WorkspacesState, wsId: string, name: string, id = newWorkspaceId()): WorkspacesState | null {
  const ws = s.list.find((w) => w.id === wsId);
  if (!ws || isWsActivity(ws) || activitiesOf(s, wsId).length >= MAX_ACTIVITIES || s.list.some((w) => w.id === id)) return null;
  const a: Workspace = { id, parent: wsId, name: tidy(name) || t.wsAct.defaultName, color: activityColor(s, ws), folder: null, order: [], active: null, layout: null };
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

/** A workspace's or an activity's color: each wears its own, so a workspace's leaves its activities' as they are. */
export function recolor(s: WorkspacesState, id: string, color: number): WorkspacesState {
  const c = inRange(color);
  return patch(s, id, (w) => ({ ...w, color: c }));
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

/**
 * The activities kept aside with `fn` applied to each entry (and to each workspace's own front and split kept there),
 * and `keys` to each workspace's joined keys.
 */
function mapParked(p: Parked, fn: (w: Workspace) => Workspace, keys: (ks: TabKey[]) => TabKey[]): Parked {
  const own = p.own && Object.fromEntries(Object.entries(p.own).map(([id, o]) => {
    const m = fn({ id, name: '', color: 1, folder: null, order: [], active: o.active, layout: o.layout });
    return [id, { active: m.active, layout: m.layout }];
  }));
  return { ...p, list: p.list.map(fn), joined: Object.fromEntries(Object.entries(p.joined).map(([w, ks]) => [w, keys(ks)])), ...(own ? { own } : {}) };
}

/** A resumed session's new id keeps its workspace and its place (an activity kept aside included). */
export function relink(s: WorkspacesState, from: string, to: string): WorkspacesState {
  if (!(from in s.members) || from === to) return s;
  const { [from]: ws, ...rest } = s.members;
  const a = `t:${from}` as TabKey;
  const b = `t:${to}` as TabKey;
  const swap = (x: TabKey) => (x === a ? b : x);
  const entry = (w: Workspace) => (w.order.includes(a) || w.active === a ? { ...w, order: w.order.map(swap), active: w.active === a ? b : w.active } : w);
  const p = s.parked;
  const parked = p && (from in p.members || p.list.some((w) => w.order.includes(a)) || Object.values(p.own ?? {}).some((o) => o.active === a))
    ? (() => { const { [from]: act, ...others } = p.members; return { ...mapParked(p, entry, (ks) => ks.map(swap)), members: act ? { ...others, [to]: act } : others }; })()
    : p;
  return {
    ...s,
    members: { ...rest, [to]: ws! },
    list: s.list.map(entry),
    ...(parked ? { parked } : {})
  };
}

/**
 * A file renamed or moved (or an untitled tab saved as a file): its key changes in every place — order, tab in
 * front, split layout — those kept aside included. The same state when no key changes.
 */
export function renameKeys(s: WorkspacesState, fn: (k: TabKey) => TabKey): WorkspacesState {
  let changed = false;
  const map = (k: TabKey) => { const n = fn(k); if (n !== k) changed = true; return n; };
  // A layout's panes: v1 one key each, v2 `{ tabs, front }`; anything else as it is.
  const entry = (w: Workspace) => ({ ...w, order: w.order.map(map), active: w.active ? map(w.active) : null, layout: mapLayoutKeys(w.layout, map) });
  const list = s.list.map(entry);
  const parked = s.parked ? mapParked(s.parked, entry, (ks) => ks.map(map)) : undefined;
  return changed ? { ...s, list, ...(parked ? { parked } : {}) } : s;
}

/**
 * Tabs closed for good (the table tabs of a removed connection, Settings › Databases › Never): out of every place's
 * order and front (those kept aside included), so no switch brings them back. The same state when none holds one.
 */
export function forget(s: WorkspacesState, gone: (k: TabKey) => boolean): WorkspacesState {
  const holds = (w: Workspace) => w.order.some(gone) || (w.active !== null && gone(w.active));
  if (!s.list.some(holds) && !s.parked?.list.some(holds)) return s;
  const entry = (w: Workspace) => ({ ...w, order: w.order.filter((k) => !gone(k)), active: w.active !== null && gone(w.active) ? null : w.active });
  const parked = s.parked ? mapParked(s.parked, entry, (ks) => ks.filter((k) => !gone(k))) : undefined;
  return { ...s, list: s.list.map(entry), ...(parked ? { parked } : {}) };
}

/** Memberships of terminals not in `keep` (neither running nor resumable) go, kept aside too; the same state if none does. */
export function prune(s: WorkspacesState, keep: Iterable<string>): WorkspacesState {
  const k = new Set(keep);
  const ids = Object.keys(s.members);
  const pids = Object.keys(s.parked?.members ?? {});
  if (ids.every((id) => k.has(id)) && pids.every((id) => k.has(id))) return s;
  const only = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).filter((id) => k.has(id)).map((id) => [id, m[id]!]));
  return { ...s, members: only(s.members), ...(s.parked ? { parked: { ...s.parked, members: only(s.parked.members) } } : {}) };
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
 * workspace's activities, in its own color. The same state when `toWs` is no workspace, is its own, or is full, or `id` is
 * no activity. The workspace it left forgets it as the place it was left at.
 */
export function moveWsActivity(s: WorkspacesState, id: string, toWs: string): WorkspacesState {
  const a = s.list.find((w) => w.id === id);
  const to = s.list.find((w) => w.id === toWs);
  if (!a || !isWsActivity(a) || !to || isWsActivity(to) || a.parent === toWs || activitiesOf(s, toWs).length >= MAX_ACTIVITIES) return s;
  const list = s.list.filter((w) => w.id !== id).map((w) => (w.id === a.parent && w.place === id ? noPlace(w) : w));
  return { ...s, list: [...list, { ...a, parent: toWs }] };
}

/**
 * Closing activity `id`: its terminals belong to its workspace from now on. move: its tabs join the workspace's own tabs
 * (keys not there yet); stop: they don't (the store stops its terminals and closes its file tabs) — its sessions wait
 * under Resume in the workspace. In front, its workspace's own tabs come forward. The same state for anything but an
 * activity.
 */
export function removeWsActivity(s: WorkspacesState, id: string, how: 'move' | 'stop'): WorkspacesState {
  const a = s.list.find((w) => w.id === id);
  if (!a || !isWsActivity(a)) return s;
  const wsId = a.parent!;
  const members = Object.fromEntries(Object.entries(s.members).map(([tid, p]) => [tid, p === id ? wsId : p]));
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
  const extra = [...new Set([...gone.order.filter((x) => x.startsWith('t:')), ...flat.flatMap((w) => w.order)])];
  const list = [
    ...s.list.filter((w) => !places.has(w.id)).map((w) => (w.id === target ? { ...w, order: [...w.order, ...extra.filter((x) => !w.order.includes(x))] } : w)),
    ...kept.map((w) => ({ ...w, parent: target!, open: false }))
  ];
  const members = Object.fromEntries(Object.entries(s.members).flatMap(([tid, p]): [string, string][] => {
    if (!places.has(p)) return [[tid, p]];
    if (!target) return [];
    return [[tid, p === id || flatIds.has(p) ? target : p]];
  }));
  const left = workspacesOf({ list });
  const active = !places.has(s.active) ? s.active : target ?? (left[Math.min(i, left.length - 1)] ?? left[0]!).id;
  const { parked: _p, ...base } = s;
  return { ...base, list, members, active, ...parkedAfterRemove(s.parked, id, target) };
}

/**
 * Its activities kept aside when workspace `id` closes: into `target` with it (they come back there when activities
 * return), or gone with their memberships (null: stopped). Its own kept front and joined keys go.
 */
function parkedAfterRemove(p: Parked | undefined, id: string, target: string | null): { parked?: Parked } {
  if (!p) return {};
  const gone = new Set(p.list.filter((w) => w.parent === id).map((w) => w.id));
  const list = target ? p.list.map((w) => (w.parent === id ? { ...w, parent: target } : w)) : p.list.filter((w) => !gone.has(w.id));
  const members = target ? p.members : Object.fromEntries(Object.entries(p.members).filter(([, a]) => !gone.has(a)));
  const { [id]: _j, ...joined } = p.joined;
  const own = p.own ? (({ [id]: _o, ...rest }) => rest)(p.own) : undefined;
  return list.length ? { parked: { list, members, joined, ...(own && Object.keys(own).length ? { own } : {}) } } : {};
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
 * Every place's tabs in the sidebar's order — each workspace's own tabs, then its activities' — with the place in
 * front's live order in its place, then the live project views: one strip for "off", and what tabs.json saves. A file
 * in several places comes once, where it first is.
 */
export function union(s: WorkspacesState, liveOrder: TabKey[]): TabKey[] {
  const seen = new Set<TabKey>();
  const out: TabKey[] = [];
  for (const w of placesInOrder(s)) {
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

/**
 * Activities turned off: they are kept aside and every workspace holds what its activities held — their terminals,
 * and their tabs after its own (sidebar order, each key once). A workspace left at an activity (the one in front
 * included) takes that activity's tab in front and split, and becomes the place in front if its activity was. Nothing
 * stops, nothing closes. The same state when there is no activity.
 */
export function parkWsActivities(s: WorkspacesState): WorkspacesState {
  const acts = s.list.filter(isWsActivity);
  if (!acts.length) return s;
  const parentOf = new Map(acts.map((a) => [a.id, a.parent!]));
  const prev: Parked = s.parked ?? { list: [], members: {}, joined: {} };
  const parkedMembers = { ...prev.members };
  const members: Record<string, string> = {};
  for (const [tid, p] of Object.entries(s.members)) {
    const ws = parentOf.get(p);
    if (ws) parkedMembers[tid] = p;
    members[tid] = ws ?? p;
  }
  const joined = { ...prev.joined };
  const own = { ...prev.own };
  const list = workspacesOf(s).map((w) => {
    const mine = activitiesOf(s, w.id);
    if (!mine.length) return noPlace(w);
    const add = [...new Set(mine.flatMap((a) => a.order))].filter((x) => !w.order.includes(x));
    if (add.length) joined[w.id] = [...(joined[w.id] ?? []), ...add];
    const at = mine.find((a) => a.id === w.place);
    if (at) own[w.id] = { active: w.active, layout: w.layout };
    return noPlace({ ...w, order: [...w.order, ...add], ...(at ? { active: at.active, layout: at.layout } : {}) });
  });
  const parked: Parked = { list: [...prev.list, ...acts], members: parkedMembers, joined, ...(Object.keys(own).length ? { own } : {}) };
  return { ...s, list, members, active: parentOf.get(s.active) ?? s.active, parked };
}

/**
 * Activities turned on again: those kept aside whose workspace is still there come back as they were (others go, with
 * their memberships), each in its own color. A terminal goes back to its activity only while it is still in that workspace (one
 * moved elsewhere meanwhile stays there); a file goes back while its workspace still shows it. What parking added to a
 * workspace's own tabs and went back leaves them; what was opened meanwhile stays. The place in front stays. The same
 * state when nothing is kept aside.
 */
export function unparkWsActivities(s: WorkspacesState): WorkspacesState {
  const p = s.parked;
  if (!p) return s;
  const { parked: _, ...rest } = s;
  const wss = new Map(workspacesOf(s).map((w) => [w.id, w]));
  const count = new Map<string, number>();
  for (const w of s.list) if (w.parent) count.set(w.parent, (count.get(w.parent) ?? 0) + 1);
  const back = p.list.filter((a) => {
    const ws = a.parent!;
    if (!wss.has(ws) || s.list.some((w) => w.id === a.id) || (count.get(ws) ?? 0) >= MAX_ACTIVITIES) return false;
    count.set(ws, (count.get(ws) ?? 0) + 1);
    return true;
  });
  const backIds = new Map(back.map((a) => [a.id, a.parent!]));
  const members = { ...s.members };
  const returning = new Set<TabKey>();
  for (const [tid, act] of Object.entries(p.members)) {
    if (backIds.has(act) && s.members[tid] === backIds.get(act)) { members[tid] = act; returning.add(`t:${tid}` as TabKey); }
  }
  const kept = new Map<string, Set<TabKey>>();
  const acts = back.map((a) => {
    const ws = wss.get(a.parent!)!;
    const shown = new Set(ws.order);
    const order = a.order.filter((x) => { const tid = termId(x); return tid ? members[tid] === a.id : shown.has(x); });
    const set = kept.get(ws.id) ?? new Set<TabKey>();
    for (const x of order) set.add(x);
    kept.set(ws.id, set);
    return { ...a, order, active: a.active && order.includes(a.active) ? a.active : null };
  });
  const list = s.list.map((w) => {
    const joined = new Set(p.joined[w.id] ?? []);
    const went = kept.get(w.id);
    const order = w.order.filter((x) => !returning.has(x) && !(went?.has(x) && joined.has(x)));
    // Left at an activity when parked: its own tab in front (while it is still one of its tabs) and split come back.
    const mine = p.own?.[w.id];
    const back = mine ? { active: mine.active && order.includes(mine.active) ? mine.active : w.active, layout: mine.layout } : {};
    return order.length === w.order.length && !mine ? w : { ...w, order, ...back };
  });
  return { ...rest, list: [...list, ...acts], members };
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
    ...(typeof v.open === 'boolean' ? { open: v.open } : {}),
    ...(typeof v.parent === 'string' && ID.test(v.parent) ? { parent: v.parent } : {}),
    ...(typeof v.place === 'string' && ID.test(v.place) ? { place: v.place } : {})
  };
}

/** Entries read one by one (junk dropped), each id once. */
function parseEntries(raw: unknown[], taken: Set<string> = new Set()): Workspace[] {
  const out: Workspace[] = [];
  for (const v of raw) {
    const w = parseOne(v);
    if (w && !taken.has(w.id) && !out.some((x) => x.id === w.id)) out.push(w);
  }
  return out;
}

/** Activities of workspaces in `wsIds` only, MAX_ACTIVITIES each (`count` holds those already kept); activities have no place. */
function keepActivities(acts: Workspace[], wsIds: Set<string>, count = new Map<string, number>()): Workspace[] {
  return acts.filter((a) => {
    const n = count.get(a.parent!) ?? 0;
    if (!wsIds.has(a.parent!) || n >= MAX_ACTIVITIES) return false;
    count.set(a.parent!, n + 1);
    return true;
  }).map(noPlace);
}

/** Activities kept aside, read like the list: those of a workspace that exists, memberships pointing into them; null if none is usable. */
function parseParked(v: unknown, wsIds: Set<string>, taken: Set<string>): Parked | null {
  if (!isObj(v) || !Array.isArray(v.list)) return null;
  const list = keepActivities(parseEntries(v.list, taken).filter(isWsActivity), wsIds);
  if (!list.length) return null;
  const ids = new Set(list.map((w) => w.id));
  const members = isObj(v.members)
    ? Object.fromEntries(Object.entries(v.members).filter(([t, a]) => TERM.test(t) && typeof a === 'string' && ids.has(a)) as [string, string][])
    : {};
  const joined = isObj(v.joined)
    ? Object.fromEntries(Object.entries(v.joined).filter(([w, ks]) => wsIds.has(w) && Array.isArray(ks)).map(([w, ks]) => [w, [...new Set((ks as unknown[]).filter(okKey))]]))
    : {};
  const own = isObj(v.own)
    ? Object.fromEntries(Object.entries(v.own).filter(([w, o]) => wsIds.has(w) && isObj(o)).map(([w, o]) => {
      const r = o as Record<string, unknown>;
      return [w, { active: okKey(r.active) ? r.active : null, layout: isObj(r.layout) ? r.layout : null }];
    }))
    : {};
  return { list, members, joined, ...(Object.keys(own).length ? { own } : {}) };
}

/**
 * A saved state read field by field (junk entries dropped, never the whole state); null if it holds no workspace.
 * At most MAX_WORKSPACES workspaces and MAX_ACTIVITIES activities each; an activity whose workspace is missing (or
 * is itself an activity) is dropped with its memberships; a workspace's place must be one of its activities. A state
 * saved before activities wore colors of their own gets them here (withOwnColors).
 */
export function parseWorkspaces(raw: unknown): WorkspacesState | null {
  if (!isObj(raw) || !Array.isArray(raw.list)) return null;
  const all = parseEntries(raw.list);
  const wsIds = new Set(all.filter((w) => !isWsActivity(w)).slice(0, MAX_WORKSPACES).map((w) => w.id));
  if (!wsIds.size) return null;
  const count = new Map<string, number>();
  const kept = new Set(keepActivities(all.filter(isWsActivity), wsIds, count).map((a) => a.id));
  const list = all
    .filter((w) => (isWsActivity(w) ? kept.has(w.id) : wsIds.has(w.id)))
    .map((w) => (isWsActivity(w) ? noPlace(w) : w.place && !all.some((a) => a.id === w.place && a.parent === w.id && kept.has(a.id)) ? noPlace(w) : w));
  const ids = new Set(list.map((w) => w.id));
  const members = isObj(raw.members)
    ? Object.fromEntries(Object.entries(raw.members).filter(([t, w]) => TERM.test(t) && typeof w === 'string' && ids.has(w)) as [string, string][])
    : {};
  const active = typeof raw.active === 'string' && ids.has(raw.active) ? raw.active : list.find((w) => !isWsActivity(w))!.id;
  const parked = parseParked(raw.parked, wsIds, ids);
  const s: WorkspacesState = {
    on: raw.on === true, active, list, members,
    ...(raw.on === true && raw.forced === true ? { forced: true as const } : {}),
    ...(parked ? { parked } : {})
  };
  return raw.ownColors === true ? { ...s, ownColors: true } : withOwnColors(s);
}

/**
 * A state saved while every activity wore its workspace's color: each activity still wearing it gets a color of its
 * own, as a new one would (activityColor), in the sidebar's order, those kept aside after the others; one already
 * apart keeps its own.
 */
function withOwnColors(s: WorkspacesState): WorkspacesState {
  const parkedIds = new Set(s.parked?.list.map((a) => a.id));
  let all = [...s.list, ...(s.parked?.list ?? [])];
  for (const w of workspacesOf(s)) {
    for (const a of activitiesOf({ list: all }, w.id)) {
      if (a.color !== w.color) continue;
      const c = activityColor({ ...s, list: all.filter((x) => x.id !== a.id) }, w);
      all = all.map((x) => (x.id === a.id ? { ...x, color: c } : x));
    }
  }
  const list = all.filter((w) => !parkedIds.has(w.id));
  const parked = s.parked ? { ...s.parked, list: all.filter((w) => parkedIds.has(w.id)) } : undefined;
  return { ...s, list, ...(parked ? { parked } : {}), ownColors: true };
}
