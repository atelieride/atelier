// Changes' Show choices: what each one keeps of the changed files, which are offered, and the Claude session in front
// they follow. Pure; every place that shows or stages "the rows Changes shows" goes through `shownChanges`.

import type { RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import { buildRows } from './changes';
import { changesInWorkspace } from './workspace-view';
import type { WorkspacesState } from './workspaces';

/** All changes, this workspace's, the activity in front's, or the Claude session in front's. */
export type ChangesScope = 'all' | 'ws' | 'activity' | 'session';

/** A changed row as the scopes read it: who touched it, each unsure entry with its candidates (`ids`). */
export interface ScopedRow { by: { terminalId: string; ids?: string[] }[] }

/**
 * The choices Show offers, widest first: All and This session always; This workspace with workspaces on; This
 * activity with activities on too. A pop-out window shows everything.
 */
export function scopesOffered(o: { wsOn: boolean; activities: boolean; popout: boolean }): ChangesScope[] {
  if (o.popout) return ['all'];
  return ['all', ...(o.wsOn ? ['ws' as const] : []), ...(o.wsOn && o.activities ? ['activity' as const] : []), 'session'];
}

/** The chosen scope while it is offered; one whose feature was turned off meanwhile behaves as All. */
export function scopeInEffect(scope: ChangesScope, offered: readonly ChangesScope[]): ChangesScope {
  return offered.includes(scope) ? scope : 'all';
}

/**
 * The Claude session This session follows: the selected terminal when it holds a session; with a plain terminal (or
 * nothing) selected, the last one while its terminal lives — a session whose Claude exited keeps it, its files are
 * still its own. Its terminal gone: none.
 */
export function frontSessionNext(prev: string | null, selectedId: string | null, terminals: readonly { id: string; session: unknown }[]): string | null {
  const sel = selectedId === null ? undefined : terminals.find((x) => x.id === selectedId);
  if (sel?.session) return sel.id;
  return prev !== null && terminals.some((x) => x.id === prev) ? prev : null;
}

/** What the rows are filtered by: the scope in effect, the workspaces (or null), the session in front, the live terminal ids. */
export interface ScopeView { scope: ChangesScope; ws: WorkspacesState | null; session: string | null; live: ReadonlySet<string> }

/** Every terminal a row's entries name: each sure entry's, and every candidate of an unsure one. */
const candidates = (r: ScopedRow): string[] => r.by.flatMap((b) => b.ids ?? [b.terminalId]);

/**
 * The rows a scope keeps, or null for everything (All). This session: the rows the session in front touched, surely
 * or as one of the candidates. This activity: the same for any session of the place in front (an activity, or the
 * workspace's own tabs): a session keeps its place after it ends; a running one not placed yet is the place in front's;
 * an ended one without a place is nobody's. Both leave out what no session made (by hand, an editor, a script): they
 * answer "what did this work change". This workspace keeps those, as it always did.
 */
export function changesInScope<R extends ScopedRow>(v: ScopeView, rows: R[]): R[] | null {
  if (v.scope === 'all') return null;
  if (v.scope === 'ws') return v.ws ? changesInWorkspace(v.ws, rows) : null;
  if (v.scope === 'session') return v.session === null ? [] : rows.filter((r) => candidates(r).includes(v.session!));
  const ws = v.ws;
  if (!ws) return null;
  const known = new Set(ws.list.map((w) => w.id));
  const inFront = (id: string): boolean => {
    const m = ws.members[id];
    if (m !== undefined && known.has(m)) return m === ws.active;
    return v.live.has(id);
  };
  return rows.filter((r) => candidates(r).some(inFront));
}

/** The store's pieces the scope reads. */
export interface ScopeState {
  ws: WorkspacesState | null;
  popout: unknown;
  changesScope: ChangesScope;
  changesSession: string | null;
  terminals: readonly { id: string }[];
  settings: { wsActivities: boolean };
}

const NONE: ReadonlySet<string> = new Set();

/** The scope in effect now, from the store. Runs on every store update: the live terminals are gathered only for This activity. */
export function scopeViewOf(s: ScopeState): ScopeView {
  const wsOn = !!s.ws?.on;
  const offered = scopesOffered({ wsOn, activities: s.settings.wsActivities, popout: !!s.popout });
  const scope = scopeInEffect(s.changesScope, offered);
  return { scope, ws: wsOn ? s.ws : null, session: s.changesSession, live: scope === 'activity' ? new Set(s.terminals.map((x) => x.id)) : NONE };
}

/**
 * Everything the rows shown depend on besides the repositories, for a view that reads them through `getState()` (to
 * render again, compared item by item): the scope, the session or place it follows, the attributions and the places'
 * members; the terminals too under This activity (a running session not placed yet is the place in front's).
 */
export function scopeInputs(s: ScopeState & { attributions: readonly unknown[] }): unknown[] {
  const v = scopeViewOf(s);
  if (v.scope === 'all') return ['all'];
  return [v.scope, v.scope === 'session' ? v.session : v.ws?.active, s.attributions, v.ws?.members, ...(v.scope === 'activity' ? [s.terminals] : [])];
}

/** The rows Changes shows under the current scope, or null when it shows everything. */
export function shownChanges<R extends ScopedRow>(s: ScopeState, rows: R[]): R[] | null {
  return changesInScope(scopeViewOf(s), rows);
}

type CountState = ScopeState & { repos: RepoStatus[]; attributions: Attribution[] };
let counted: { key: unknown[]; n: number } | null = null;
/**
 * The strip's Changes count: what Changes shows. A store selector runs on every update: the rows are built and
 * filtered again only when what they read changed (the terminals only matter to This activity).
 */
export function shownChangeCount(s: CountState): number {
  const v = scopeViewOf(s);
  if (v.scope === 'all') return s.repos.reduce((n, r) => n + r.changes.length, 0);
  const key = [v.scope, v.ws, v.session, s.repos, s.attributions, v.scope === 'activity' ? s.terminals : null];
  if (counted && counted.key.every((x, i) => x === key[i])) return counted.n;
  const n = changesInScope(v, buildRows(s.repos, s.attributions))?.length ?? 0;
  counted = { key, n };
  return n;
}
