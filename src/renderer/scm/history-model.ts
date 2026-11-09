// The History list's model: pages of commits with their graph rows, reloads that keep the
// place, the virtual window and keyboard steps. Pure functions.
import { HISTORY_CAP, HISTORY_PAGE, type ScmCommit } from '@shared/scm';
import { emptyGraph, layoutGraph, type GraphRow, type GraphState } from '@shared/git-graph';

/** Pseudo rows: the uncommitted changes above HEAD, and a compare's "All changes since <base>". */
export const WORKTREE_ROW = 'WORKTREE';
export const COMPARE_ROW = 'COMPARE';
export const isPseudo = (oid: string) => oid === WORKTREE_ROW || oid === COMPARE_ROW;

export interface HistoryRows {
  commits: ScmCommit[];
  /** One per commit when the graph is drawn, none otherwise. */
  graph: GraphRow[];
  state: GraphState;
  /** The current branch's first-parent chain seen so far (lane 0). */
  mainline: Set<string>;
  maxLanes: number;
  done: boolean;
  capped: boolean;
}

const pseudo = (oid: string, parents: string[]): ScmCommit => ({ oid, parents, author: { name: '', email: '' }, authorAt: 0, committer: { name: '', email: '' }, committerAt: 0, subject: '', coAuthors: [] });

/** An empty list for a scope whose HEAD (null: none in this scope) leads lane 0, with its pseudo rows. */
export function emptyRows(head: string | null, o: { worktree?: boolean; compare?: boolean } = {}): HistoryRows {
  const mainline = new Set<string>(head ? [head] : []);
  const commits: ScmCommit[] = [];
  if (o.compare) commits.push(pseudo(COMPARE_ROW, []));
  if (o.worktree && head) { commits.push(pseudo(WORKTREE_ROW, [head])); mainline.add(WORKTREE_ROW); }
  return { commits, graph: [], state: emptyGraph(), mainline, maxLanes: 1, done: false, capped: false };
}

const NO_NODE: GraphRow = { lane: -1, color: 0, top: [], bottom: [], width: 0 };

/** A page appended; with the graph, every row not laid out yet (the pseudo rows the first time) gets its lanes. */
export function appendPage(h: HistoryRows, page: ScmCommit[], end: { done: boolean; capped: boolean }, o: { graph: boolean; firstParent: boolean }): HistoryRows {
  const commits = [...h.commits, ...page];
  if (!o.graph) return { ...h, commits, graph: [], done: end.done, capped: end.capped };
  const fresh = commits.slice(h.graph.length);
  const mainline = new Set(h.mainline);
  for (const c of fresh) if (mainline.has(c.oid) && c.parents[0]) mainline.add(c.parents[0]);
  const laid = fresh.filter((c) => c.oid !== COMPARE_ROW).map((c) => ({ oid: c.oid, parents: o.firstParent ? c.parents.slice(0, 1) : c.parents }));
  const out = layoutGraph(laid, h.state, mainline);
  const graph = [...h.graph];
  let maxLanes = h.maxLanes;
  let k = 0;
  for (const c of fresh) {
    if (c.oid === COMPARE_ROW) { graph.push(NO_NODE); continue; }
    const row = out.rows[k++]!;
    graph.push(row);
    maxLanes = Math.max(maxLanes, row.width);
  }
  return { commits, graph, state: out.state, mainline, maxLanes, done: end.done, capped: end.capped };
}

/**
 * A reload after refs changed: the fresh rows replace the old ones. `newOids`/`added`: commits that weren't listed
 * before, wherever they land among what was loaded (the pill, the fade); none when the old top is gone (a rewritten
 * history). `shift`: how many rows the anchor row (the first on screen; the top by default) moved, to keep the place.
 */
export function mergeReload(prev: HistoryRows, fresh: HistoryRows, anchor?: number): { rows: HistoryRows; added: number; newOids: string[]; shift: number } {
  const real = (h: HistoryRows) => h.commits.filter((c) => !isPseudo(c.oid));
  const old = real(prev);
  const top = old[0]?.oid;
  if (!top || !real(fresh).some((c) => c.oid === top)) return { rows: fresh, added: 0, newOids: [], shift: 0 };
  // Only within what was loaded: older commits a deeper reload brings in are not new.
  const seen = new Set(old.map((c) => c.oid));
  const last = old.at(-1)!.oid;
  const end = real(fresh).findIndex((c) => c.oid === last);
  const span = end < 0 ? real(fresh) : real(fresh).slice(0, end + 1);
  const newOids = span.filter((c) => !seen.has(c.oid)).map((c) => c.oid);
  const at = prev.commits[anchor ?? prev.commits.findIndex((c) => c.oid === top)];
  const before = at ? prev.commits.indexOf(at) : -1;
  const after = at ? fresh.commits.findIndex((c) => c.oid === at.oid) : -1;
  return { rows: fresh, added: newOids.length, newOids, shift: before >= 0 && after >= 0 ? after - before : 0 };
}

/** The list's last row: more loading, a retry after a page failed, the cap, a shallow clone's end, or nothing. */
export function historyFooter(rows: HistoryRows, o: { shallow: boolean; moreFailed: boolean }): 'loading' | 'retry' | 'capped' | 'shallow' | null {
  if (!rows.done) return o.moreFailed ? 'retry' : 'loading';
  if (rows.capped) return 'capped';
  return o.shallow ? 'shallow' : null;
}

/** Rows to keep in the DOM: what is on screen plus `overscan` above and below. */
export function visibleWindow(scrollTop: number, height: number, total: number, rowH = 28, overscan = 20): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + height) / rowH) + overscan);
  return { start, end: Math.max(start, end) };
}

export function stepSelection(total: number, cur: number | null, key: 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown', page: number): number | null {
  if (total === 0) return null;
  if (cur === null) return key === 'end' ? total - 1 : 0;
  const to = key === 'up' ? cur - 1 : key === 'down' ? cur + 1 : key === 'home' ? 0 : key === 'end' ? total - 1 : key === 'pageUp' ? cur - page : cur + page;
  return Math.max(0, Math.min(total - 1, to));
}

/**
 * The jump to a commit a hex word named, next: select it once it is loaded (once per jump); else locate it, one deeper
 * load per jump — counted only once a locate answered (`located`), so an answer dropped because the rows changed
 * meanwhile is asked again instead of leaving the commit unselected.
 */
export function jumpNext(jump: string, rows: { commits: readonly { oid: string }[]; done: boolean }, o: { located: string | null; selected: string | null }):
  { kind: 'select'; at: number } | { kind: 'locate' } | { kind: 'none' } {
  const at = rows.commits.findIndex((c) => c.oid === jump);
  if (at >= 0) return o.selected === jump ? { kind: 'none' } : { kind: 'select', at };
  return rows.done || o.located === jump ? { kind: 'none' } : { kind: 'locate' };
}

/** The pages a reload reads so the list keeps the depth already loaded (pages of at most 4 000, up to the cap). */
export function reloadChunks(loaded: number, page = HISTORY_PAGE, max = HISTORY_PAGE * 10, cap = HISTORY_CAP): { skip: number; count: number }[] {
  const total = Math.min(cap, Math.max(page, Math.ceil(loaded / page) * page));
  const out: { skip: number; count: number }[] = [];
  for (let skip = 0; skip < total; skip += max) out.push({ skip, count: Math.min(max, total - skip) });
  return out;
}
