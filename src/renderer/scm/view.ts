// Source Control view helpers: what the switcher, the sections and the history rows show.
// Pure functions.
import type { RepoSearch, ScmFetchState, ScmHead, ScmPerson, ScmRef, ScmRefs, ScmRepoEntry, ScmRepoStatus, ScmScope } from '@shared/scm';
import { OID_RE } from '@shared/scm';
import { upstreamKind } from '@shared/git-write';
import { relativeTime } from '../history';
import { t } from '../i18n/en';
import { isBelow } from '@shared/paths';

const short7 = (oid: string) => oid.slice(0, 7);

/** refs/heads/main → main; refs/remotes/origin/x → origin/x; refs/tags/v1 → v1; a commit id → its short form. */
export function shortRef(name: string): string {
  if (OID_RE.test(name)) return short7(name);
  for (const p of ['refs/heads/', 'refs/remotes/', 'refs/tags/']) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

/**
 * How an entry is named: its folder part dimmed, its name bold. A hidden-folder worktree reads "atelier › scm-minors"
 * (whose worktree, then its folder's name) with a "worktree" note, never its long path. A repository inside another
 * one gets a "nested" note whose tip names that one. `dir + name` is the matched text.
 */
export function repoLabel(e: ScmRepoEntry): { dir: string; name: string; note: string | null; tip: string | null } {
  if (e.worktreeOf) return { dir: `${e.worktreeOf.split('/').at(-1) ?? e.worktreeOf} › `, name: e.name, note: t.scm.worktree, tip: null };
  const text = e.rel || e.name;
  const i = text.lastIndexOf('/');
  const label = { dir: i >= 0 ? text.slice(0, i + 1) : '', name: i >= 0 ? text.slice(i + 1) : text };
  if (!e.nestedIn) return { ...label, note: null, tip: null };
  // The project's folder: the entry's root without its path inside the project.
  const project = e.rel ? e.root.slice(0, e.root.length - e.rel.length - 1) : e.root;
  const parent = e.nestedIn === project ? project.split('/').at(-1) ?? project : e.nestedIn.slice(project.length + 1);
  return { ...label, note: t.scm.nested, tip: t.scm.nestedTip(parent) };
}

/** What an empty list of repositories says while the project's first folder scan runs (nothing once it ended). */
export function lookingForRepos(search: RepoSearch | null): string | null {
  return search?.searching ? t.scm.searching : null;
}

/** "main · synced", "feat/x · ↑4", "main · ↑2 ↓1", "main · local", "detached · f0d6c52": short for the sidebar. */
export function branchLine(st: ScmRepoStatus | null): string {
  if (!st) return '';
  if (st.detached || !st.branch) return st.oid ? t.scm.detachedShort(short7(st.oid)) : '';
  if (!st.oid) return t.scm.noCommitsYet(st.branch);
  const up = upstreamKind(st.branch, st.upstream, st.upstreamGone);
  if (!st.upstream || up === 'none') return t.scm.noUpstream(st.branch);
  if (up === 'gone') return t.scm.upstreamGone(st.branch);
  if (up === 'other') return t.scm.otherUpstream(st.branch, st.upstream);
  if (st.ahead && st.behind) return t.scm.diverged(st.branch, st.ahead, st.behind);
  if (st.ahead) return t.scm.ahead(st.branch, st.ahead);
  if (st.behind) return t.scm.behind(st.branch, st.behind);
  return t.scm.inSync(st.branch);
}

/** The branch line in full, for its tooltip. */
export function branchTip(st: ScmRepoStatus | null): string {
  if (!st) return '';
  const tip = t.scm.tip;
  if (st.detached || !st.branch) return st.oid ? tip.detached(short7(st.oid)) : '';
  if (!st.oid) return tip.noCommits(st.branch);
  const up = upstreamKind(st.branch, st.upstream, st.upstreamGone);
  if (!st.upstream || up === 'none') return tip.noUpstream(st.branch);
  if (up === 'gone') return tip.upstreamGone(st.branch, st.upstream);
  if (up === 'other') return tip.otherUpstream(st.branch, st.upstream);
  if (st.ahead && st.behind) return tip.diverged(st.branch, st.ahead, st.behind, st.upstream);
  if (st.ahead) return tip.ahead(st.branch, st.ahead, st.upstream);
  if (st.behind) return tip.behind(st.branch, st.behind, st.upstream);
  return tip.inSync(st.branch, st.upstream);
}

export interface LiveSession { id: string; title: string; color: string; cwd: string; at: number }
export interface SwitcherRow { entry: ScmRepoEntry; match: [number, number][]; sessions: LiveSession[] }

/** The deepest entry a folder is in. */
function entryOf(entries: ScmRepoEntry[], cwd: string): ScmRepoEntry | null {
  let best: ScmRepoEntry | null = null;
  for (const e of entries) if ((cwd === e.root || isBelow(e.root, cwd)) && (!best || e.root.length > best.root.length)) best = e;
  return best;
}

const label = (e: ScmRepoEntry) => { const l = repoLabel(e); return l.dir + l.name; };

/**
 * The switcher's two groups: Active — the selected entry, then entries with changes or a live session,
 * by latest session activity then name; All — the rest by path. A query keeps the entries whose path contains it.
 */
export function switcherGroups(entries: ScmRepoEntry[], selected: string | null, sessions: LiveSession[], query: string): { active: SwitcherRow[]; all: SwitcherRow[]; total: number } {
  const by = new Map<string, LiveSession[]>();
  for (const s of sessions) {
    const e = entryOf(entries, s.cwd);
    if (e) by.set(e.root, [...(by.get(e.root) ?? []), s]);
  }
  const q = query.trim().toLowerCase();
  const rows: SwitcherRow[] = [];
  for (const e of entries) {
    let match: [number, number][] = [];
    if (q) {
      // The name shown (highlighted), else the path inside the project.
      const i = label(e).toLowerCase().indexOf(q);
      if (i >= 0) match = [[i, i + q.length]];
      else if (!(e.rel || e.name).toLowerCase().includes(q)) continue;
    }
    rows.push({ entry: e, match, sessions: (by.get(e.root) ?? []).sort((a, b) => b.at - a.at) });
  }
  const latest = (r: SwitcherRow) => r.sessions[0]?.at ?? 0;
  const busy = (r: SwitcherRow) => r.sessions.length > 0 || (r.entry.status?.changes ?? 0) > 0;
  const byName = (a: SwitcherRow, b: SwitcherRow) => label(a.entry).localeCompare(label(b.entry));
  const sel = rows.filter((r) => r.entry.root === selected);
  const others = rows.filter((r) => r.entry.root !== selected);
  const active = [...sel, ...others.filter(busy).sort((a, b) => latest(b) - latest(a) || byName(a, b))];
  const all = others.filter((r) => !busy(r)).sort(byName);
  return { active, all, total: entries.length };
}

/**
 * The switcher's cursor row: the repository it is on, wherever the list moved it (a status or a session reorders
 * Active while it is open; Enter must pick what is highlighted), else the first row.
 */
export function cursorIndex(rows: readonly SwitcherRow[], root: string | null): number {
  return Math.max(0, rows.findIndex((r) => r.entry.root === root));
}

export interface RefSections {
  local: ScmRef[];
  remotes: { name: string; refs: ScmRef[] }[];
  tags: ScmRef[];
  more: { local: number; tags: number; remotes: Record<string, number> };
  counts: { local: number; remote: number; tags: number };
}

/** Branches (current first, then newest), one group per remote (newest first), tags newest first; each up to its limit. */
export function refSections(refs: ScmRefs, limit: { local: number; remote: number; tags: number }): RefSections {
  const newest = (a: ScmRef, b: ScmRef) => b.date - a.date || a.short.localeCompare(b.short);
  const locals = refs.refs.filter((r) => r.kind === 'head').sort((a, b) => Number(b.current) - Number(a.current) || newest(a, b));
  const remotes = refs.refs.filter((r) => r.kind === 'remote');
  const tags = refs.refs.filter((r) => r.kind === 'tag').sort(newest);
  const names = [...new Set(remotes.map((r) => r.remote ?? ''))];
  const groups = names.map((name) => ({ name, refs: remotes.filter((r) => (r.remote ?? '') === name).sort(newest) }));
  return {
    local: locals.slice(0, limit.local),
    remotes: groups.map((g) => ({ name: g.name, refs: g.refs.slice(0, limit.remote) })),
    tags: tags.slice(0, limit.tags),
    more: { local: Math.max(0, locals.length - limit.local), tags: Math.max(0, tags.length - limit.tags), remotes: Object.fromEntries(groups.map((g) => [g.name, Math.max(0, g.refs.length - limit.remote)])) },
    counts: { local: locals.length, remote: remotes.length, tags: tags.length }
  };
}

/** A remote branch a local one tracks: how many commits the local is ahead of it (null when none tracks it). */
export function remoteLag(remote: ScmRef, refs: ScmRefs): number | null {
  const local = refs.refs.find((r) => r.kind === 'head' && r.upstream === remote.name);
  return local && local.ahead > 0 ? local.ahead : null;
}

export function refsByOid(refs: ScmRef[]): Map<string, ScmRef[]> {
  const m = new Map<string, ScmRef[]>();
  for (const r of refs) m.set(r.oid, [...(m.get(r.oid) ?? []), r]);
  return m;
}

export type PillKind = 'head' | 'local' | 'remote' | 'tag';
const PILL_ORDER: Record<PillKind, number> = { head: 0, local: 1, remote: 2, tag: 3 };

/** The ref pills before a commit's subject: HEAD's branch, other locals, remotes, tags. */
export function refPills(oid: string, byOid: Map<string, ScmRef[]>, head: ScmHead): { label: string; kind: PillKind }[] {
  const pills = (byOid.get(oid) ?? []).map((r) => ({ label: r.short, kind: (r.kind === 'head' ? (r.current ? 'head' : 'local') : r.kind) as PillKind }));
  if (head.detached && head.oid === oid) pills.unshift({ label: 'HEAD', kind: 'head' });
  return pills.sort((a, b) => PILL_ORDER[a.kind] - PILL_ORDER[b.kind]);
}

/** A conventional commit's type prefix ("feat(scope):", "fix!:"), shown dimmed before the rest. */
export function conventional(subject: string): { prefix: string | null; rest: string } {
  const m = /^([a-z]+(?:\([^)\s]*\))?!?:)\s+(.*)$/.exec(subject);
  return m ? { prefix: m[1]!, rest: m[2]! } : { prefix: null, rest: subject };
}

export const isClaude = (p: ScmPerson): boolean => /claude/i.test(p.name) || /@anthropic\.com$/i.test(p.email);

/** An author's avatar color, stable per email: one of the session avatar colors (theme tokens). */
export function personColor(email: string): string {
  let h = 5381;
  for (const ch of email.toLowerCase()) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `var(--person-${(h % 8) + 1})`;
}

export interface FetchChip { text: string; tone: 'fresh' | 'stale' | 'running' | 'failed'; tip: string }

/**
 * The fetch chip: "Fetching…" while a fetch runs; "Fetch needs sign-in" / "Fetch failed · 3m ago" when
 * Atelier's last fetch failed and nothing fetched since; else "origin fetched 12m ago" (fresh under an hour) or "never
 * fetched". Nothing without a remote.
 */
export function fetchChip(refs: ScmRefs, state: ScmFetchState | undefined, now: number): FetchChip | null {
  if (!refs.hasRemote) return null;
  const f = t.scm.fetch;
  if (state?.running) return { text: f.running, tone: 'running', tip: f.runningTip };
  const last = state?.last;
  if (last && last.outcome !== 'ok' && last.at > (refs.fetchedAt ?? 0)) {
    const tip = last.message ? `${last.message} · ${f.retry}` : f.retry;
    return last.outcome === 'auth' ? { text: f.signIn, tone: 'failed', tip } : { text: f.failed(relativeTime(last.at, now)), tone: 'failed', tip };
  }
  // The refs may have been read just before Atelier's own fetch finished: the later of the two.
  const fetchedAt = Math.max(refs.fetchedAt ?? 0, last?.outcome === 'ok' ? last.at : 0) || null;
  if (fetchedAt === null) return { text: t.scm.history.neverFetched, tone: 'stale', tip: f.idleTip };
  const remotes = [...refs.remotes, ...refs.refs.filter((r) => r.kind === 'remote').map((r) => r.remote ?? '')].filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin';
  return { text: t.scm.history.fetched(remote, relativeTime(fetchedAt, now)), tone: now - fetchedAt < 3600_000 ? 'fresh' : 'stale', tip: f.idleTip };
}

/** "All branches", "v2.2-integrate", "feat/x vs main". */
export function scopeTitle(scope: ScmScope): string {
  if (scope.kind === 'compare') return t.scm.history.vs(shortRef(scope.head), shortRef(scope.base));
  return scope.refs === 'all' ? t.scm.history.allBranches : shortRef(scope.refs);
}
