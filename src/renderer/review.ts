// Review view: changed files as read-only hunks, per session or for the whole project. Pure functions.
import type { RepoCompare, RepoStatus } from '@shared/git';
import type { Attribution } from '@shared/attribution';
import type { DiffDoc } from './editor/linediff';
import type { TerminalInfo } from '@shared/protocol';
import { buildRows, type ChangeRow } from './changes';
import { t } from './i18n/en';

/** What a review is about: "All changes", the session's title, or the title its attributions remember once closed. */
export function reviewScopeTitle(scope: ReviewScope, terminals: Pick<TerminalInfo, 'id' | 'title'>[], attributions: Attribution[]): string {
  if (scope === 'all') return t.review.allChanges;
  if (scope.startsWith('repo:')) return scope.split('/').at(-1) ?? scope;
  return terminals.find((x) => x.id === scope)?.title ?? attributions.find((a) => a.terminalId === scope)?.title ?? t.review.closedSession;
}

/** 'all', a terminal id, or 'repo:<root>' (one working tree: a linked worktree's review). */
export type ReviewScope = string;

export interface Hunk { from: number; to: number; oldStart: number; oldLines: number; newStart: number; newLines: number }

/** The changed regions of a unified diff (rows from..to of doc.lines, half-open), with `context` lines around, like git. */
export function hunksOf(doc: DiffDoc, context = 3): Hunk[] {
  const rows = doc.lines;
  const ranges: [number, number][] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === 'ctx') continue;
    const from = Math.max(0, i - context);
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]!.kind !== 'ctx') j++;
    const to = Math.min(rows.length, j + 1 + context);
    const last = ranges.at(-1);
    // Contexts touching or overlapping: one hunk.
    if (last && from <= last[1]) last[1] = to; else ranges.push([from, to]);
    i = j;
  }
  return ranges.map(([from, to]) => {
    const slice = rows.slice(from, to);
    const olds = slice.filter((l) => l.oldNo !== null).map((l) => l.oldNo!);
    const news = slice.filter((l) => l.newNo !== null).map((l) => l.newNo!);
    const before = rows.slice(0, from);
    const lastOld = [...before].reverse().find((l) => l.oldNo !== null)?.oldNo ?? 0;
    const lastNew = [...before].reverse().find((l) => l.newNo !== null)?.newNo ?? 0;
    return { from, to, oldStart: olds[0] ?? lastOld, oldLines: olds.length, newStart: news[0] ?? lastNew, newLines: news.length };
  });
}

export interface ReviewDoc extends DiffDoc {
  /** line: 1-based line of the compact text where the hunk starts; firstChange: the new-file line to open at. */
  hunks: { line: number; header: string; firstChange: number | null }[];
}

/** Only the hunks' rows, one after the other: the text of a read-only view and where each hunk starts. */
export function compactDoc(doc: DiffDoc, hunks: Hunk[]): ReviewDoc {
  const all = doc.text.split('\n');
  const text: string[] = [];
  const lines: DiffDoc['lines'] = [];
  const marks: ReviewDoc['hunks'] = [];
  for (const h of hunks) {
    const firstRow = doc.lines.slice(h.from, h.to).findIndex((l) => l.kind !== 'ctx');
    const after = firstRow < 0 ? [] : doc.lines.slice(h.from + firstRow);
    const firstChange = after.find((l) => l.newNo !== null)?.newNo ?? null;
    marks.push({ line: lines.length + 1, header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, firstChange });
    for (let i = h.from; i < h.to; i++) { text.push(all[i] ?? ''); lines.push(doc.lines[i]!); }
  }
  return { text: text.join('\n'), lines, hunks: marks };
}

/**
 * The files of a review: every changed file (scope 'all') or those attributed to one session (Edit/Write or via Bash).
 * Against main, a repo that can compare lists what its branch changes since it left the default branch; the others
 * keep their working tree.
 */
export function reviewRows(repos: RepoStatus[], attributions: Attribution[], scope: ReviewScope, compares: RepoCompare[] | null): ChangeRow[] {
  const roots = new Set(repos.map((r) => r.root));
  const sources = repos.map((r) => {
    const c = compares?.find((x) => x.root === r.root);
    // A linked worktree's folder is its own working tree, never an untracked file of its repo (worktrees in Changes).
    return c?.ok ? { root: r.root, changes: c.changes.filter((x) => !(x.kind === '?' && roots.has(x.path.replace(/\/+$/, '')))) } : r;
  });
  const rows = buildRows(sources, attributions);
  if (scope === 'all') return rows;
  if (scope.startsWith('repo:')) return rows.filter((r) => r.repo === scope.slice(5));
  return rows.filter((r) => r.by.some((b) => b.terminalId === scope));
}

/** Where a row's base side is read: the merge base of its repo against main, else HEAD. */
export function baseRevOf(row: ChangeRow, compares: RepoCompare[] | null): string {
  const c = compares?.find((x) => x.root === row.repo);
  return c?.ok ? c.mergeBase : 'HEAD';
}

/** "Against main" is offered when at least one repo can compare: the default branch's name and the commits since. */
export function compareAvailable(compares: RepoCompare[] | null): { base: string; commits: number } | null {
  const ok = (compares ?? []).filter((c): c is Extract<RepoCompare, { ok: true }> => c.ok);
  if (!ok.length) return null;
  return { base: ok[0]!.base, commits: ok.reduce((n, c) => n + c.commits, 0) };
}

/** The review's body: "Comparing with the default branch…" while Against main waits for its first answer, else the files or the empty state. */
export function reviewBody(againstMain: boolean, compares: RepoCompare[] | null, rows: number): 'comparing' | 'empty' | 'files' {
  if (againstMain && compares === null) return 'comparing';
  return rows ? 'files' : 'empty';
}

export interface NavStop { file: number; hunk: number }

/** Keyboard stops: each hunk of a loaded file; a file not loaded, collapsed or too big is one stop (its header, -1). */
export function navStops(hunkCounts: (number | null)[]): NavStop[] {
  return hunkCounts.flatMap((n, file) => (n === null || n === 0 ? [{ file, hunk: -1 }] : Array.from({ length: n }, (_, hunk) => ({ file, hunk }))));
}

/** ↑↓ (hunk) or n/p (file): the next stop, staying at the ends; from nothing, the first (or last) one. */
export function stepNav(stops: NavStop[], cur: NavStop | null, by: 'hunk' | 'file', dir: 1 | -1): NavStop | null {
  if (!stops.length) return null;
  if (!cur) return dir === 1 ? stops[0]! : stops.at(-1)!;
  let i = stops.findIndex((s) => s.file === cur.file && s.hunk === cur.hunk);
  if (i < 0) {
    // That hunk is gone (the file reloaded): the nearest stop of the same file, else the first one after it.
    const same = stops.filter((s) => s.file === cur.file);
    if (same.length) return same.reduce((a, b) => (Math.abs(b.hunk - cur.hunk) < Math.abs(a.hunk - cur.hunk) ? b : a));
    i = stops.findIndex((s) => s.file > cur.file);
    return i < 0 ? stops.at(-1)! : stops[i]!;
  }
  if (by === 'hunk') return stops[Math.min(stops.length - 1, Math.max(0, i + dir))]!;
  const target = cur.file + dir;
  const first = stops.find((s) => s.file === target);
  if (first) return first;
  return dir === 1 ? stops.filter((s) => s.file === cur.file).at(-1)! : stops.find((s) => s.file === cur.file)!;
}
