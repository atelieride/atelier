// The ref picker's groups: with an empty query the current branch, the refs viewed lately,
// then local branches by date; with a query a fuzzy match on short names in every group. Pure functions.
import type { ScmRef, ScmRefs, ScmRepoEntry } from '@shared/scm';
import { fuzzyFilter } from '@shared/fuzzy';

/**
 * The working tree of this repository (`root`'s common dir) a local branch is checked out in, if any: the picker names
 * it ("worktree of …") and the session working there. Never another repository's, whatever its branch is called.
 */
export function checkedOutIn(entries: readonly ScmRepoEntry[] | null | undefined, root: string | null, branch: string): ScmRepoEntry | null {
  const here = entries?.find((e) => e.root === root);
  return (here && entries!.find((e) => e.common === here.common && e.status?.branch === branch)) || null;
}

/**
 * The picker's cursor row: the row it is on by its key, wherever the list moved it (a refs reload reorders Local by
 * date while open; Enter must act on what is highlighted), else the first row.
 */
export function rowCursor(keys: readonly string[], at: string | null): number {
  return Math.max(0, at === null ? 0 : keys.indexOf(at));
}

export interface PickerItem { ref: ScmRef; match: number[] }
export interface PickerGroups { recent: PickerItem[]; local: PickerItem[]; remote: PickerItem[]; tags: PickerItem[] }

const LIMIT = 50;

/** Where the query's characters fall in `text` (in order, case-insensitive), for highlighting; [] without a match. */
export function matchPositions(query: string, text: string): number[] {
  if (!query) return [];
  const q = query.toLowerCase(); const s = text.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return [];
    out.push(i);
    from = i + 1;
  }
  return out;
}

export function pickerGroups(refs: ScmRefs, query: string, recent: string[]): PickerGroups {
  const q = query.trim();
  const newest = (a: ScmRef, b: ScmRef) => b.date - a.date || a.short.localeCompare(b.short);
  const of = (kind: ScmRef['kind']) => refs.refs.filter((r) => r.kind === kind).sort(newest);
  const item = (r: ScmRef): PickerItem => ({ ref: r, match: matchPositions(q, r.short) });
  if (q) {
    const pick = (list: ScmRef[]) => fuzzyFilter(list, q, (r) => r.short, LIMIT).map(item);
    return { recent: [], local: pick(of('head')), remote: pick(of('remote')), tags: pick(of('tag')) };
  }
  const current = refs.refs.find((r) => r.current);
  const lately = recent.map((n) => refs.refs.find((r) => r.name === n)).filter((r): r is ScmRef => !!r && r !== current);
  const first = [...(current ? [current] : []), ...lately];
  const shown = new Set(first.map((r) => r.name));
  return {
    recent: first.map(item),
    local: of('head').filter((r) => !shown.has(r.name)).slice(0, LIMIT).map(item),
    remote: of('remote').filter((r) => !shown.has(r.name)).slice(0, LIMIT).map(item),
    tags: of('tag').filter((r) => !shown.has(r.name)).slice(0, LIMIT).map(item)
  };
}
