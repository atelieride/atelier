import type { FileChange, RepoStatus } from '@shared/git';
import { isUnsure, type Attribution } from '@shared/attribution';
import { describeTool, type SessionState } from '@shared/session';
import { t } from './i18n/en';
import { isBelow, samePath, trimOneSep } from '@shared/paths';
import { dubiousOwnership } from './git/unsafe';
import { idStyle } from './avatar';

/**
 * Who touched a row's file. Unsure entries (`unclear`: the candidates' names; `maybe`) also carry what "Why unsure"
 * shows: `ids` (the candidates' terminal ids, sorted), `at` (the status read that saw the change) and the call
 * (`changedAt`, `command`, `callStart`, `callEnd`). `resolved`: the user said it was this session.
 */
export interface ChangeBy {
  terminalId: string; color: string; title: string; via?: 'bash' | 'tool'; tool?: string; unclear?: string[]; maybe?: true;
  ids?: string[]; at?: number; changedAt?: number; command?: string; callStart?: number; callEnd?: number; resolved?: true;
  cwd?: string;
}
export interface ChangeRow extends FileChange { repo: string; by: ChangeBy[] }

export function buildRows(repos: Pick<RepoStatus, 'root' | 'changes'>[], attributions: Attribution[]): ChangeRow[] {
  const byPath = new Map<string, Attribution[]>();
  for (const a of attributions) byPath.set(a.path, [...(byPath.get(a.path) ?? []), a]);
  return repos.flatMap((r) => r.changes.map((c) => {
    const list = (byPath.get(c.path) ?? []).sort((x, y) => x.at - y.at);
    // An unclear entry names every candidate still known for this file (sorted, for a stable tooltip).
    const names = (ids: string[]) => ids.map((id) => list.find((x) => x.terminalId === id)?.title).filter((n): n is string => !!n).sort((x, y) => x.localeCompare(y));
    return {
      ...c, repo: r.root,
      by: list.map((a) => ({
        terminalId: a.terminalId, color: a.color, title: a.title,
        ...(a.via ? { via: a.via } : {}), ...(a.tool ? { tool: a.tool } : {}), ...(a.unclear ? { unclear: names(a.unclear) } : {}),
        ...(a.maybe ? { maybe: true as const } : {}), ...(a.resolved ? { resolved: true as const } : {}),
        ...(isUnsure(a) ? { ids: [...(a.unclear ?? [a.terminalId])].sort(), at: a.at } : {}),
        ...(a.changedAt !== undefined ? { changedAt: a.changedAt } : {}), ...(a.command ? { command: a.command } : {}),
        ...(a.callStart !== undefined ? { callStart: a.callStart } : {}), ...(a.callEnd !== undefined ? { callEnd: a.callEnd } : {}),
        ...(a.cwd ? { cwd: a.cwd } : {})
      }))
    };
  }));
}

/** The tooltip of a session's dot: its name, how it was attributed, the candidates when unclear, or a maybe. */
export function originTip(b: ChangeBy): string {
  if (b.unclear) return t.unclearTip(b.unclear);
  if (b.maybe) return t.maybeTip(b.title);
  if (b.resolved) return t.resolvedTip(b.title);
  if (b.via === 'tool' && b.tool) return t.viaTool(b.title, describeTool(b.tool, {}));
  return b.via === 'bash' ? t.viaBash(b.title) : b.title;
}

/**
 * A session's dot: filled for an Edit/Write, a ring in the session's color for a command or tool of that session
 * alone (with a person mark when the user said so), a dashed ring when several sessions were running commands or only
 * a background command of one was (rows draw those as one chip: `chipOf`).
 */
export function dotProps(b: ChangeBy): { className: string; style: Record<string, string> } {
  // The session's color reaches CSS as --id (avatar.ts): a fill is .id-dot, a ring drawn in currentColor .id-ink.
  const style = idStyle(b.color);
  if (b.unclear || b.maybe) return { className: 'dot unclear id-ink', style };
  if (b.resolved) return { className: 'dot via-bash is-resolved id-ink', style };
  return b.via ? { className: 'dot via-bash id-ink', style } : { className: 'dot id-dot', style };
}

/** The row's unsure entries (one per candidate). */
export const unsureOf = (row: ChangeRow): ChangeBy[] => row.by.filter(isUnsure);

/**
 * The "either" chip of a row: its candidates' colors in session order (`order`, from
 * sessionOrderKey) and the tooltip; null when nothing about the row is unsure.
 */
export function chipOf(row: ChangeRow, order: readonly string[]): { colors: string[]; tip: string } | null {
  const unsure = inSessionOrder(unsureOf(row), order);
  if (unsure.length === 0) return null;
  return { colors: unsure.map((b) => b.color), tip: `${originTip(unsure[0]!)}. ${t.unsure.clickWhy}` };
}

/** What makes two unsure rows "the same moment": the same candidates seen by the same status read. */
function momentKey(row: ChangeRow): string | null {
  const b = unsureOf(row)[0];
  return b ? `${b.at}|${b.maybe ? 'maybe' : 'unclear'}|${(b.ids ?? []).join(',')}` : null;
}

/**
 * Where a candidate's call ran (its `cwd`, a real path), for "Why unsure": in the changed file's own working tree
 * (`repo`), or elsewhere — relative to the project when inside it. A hint, never a decision.
 */
export function whereRan(cwd: string | undefined, repo: string, repos: readonly Pick<RepoStatus, 'root'>[], projectRoot: string): { same: boolean; label: string } | null {
  if (!cwd) return null;
  const inside = (root: string, p: string) => samePath(root, p) || isBelow(trimOneSep(root), p);
  let tree: string | null = null;
  for (const r of repos) if (inside(r.root, cwd) && (!tree || r.root.length > tree.length)) tree = r.root;
  if (tree === repo) return { same: true, label: t.unsure.sameCheckout };
  const rel = projectRoot && inside(projectRoot, cwd) ? cwd.slice(projectRoot.length).replace(/^\//, '') || t.unsure.projectFolder : cwd;
  return { same: false, label: t.unsure.ranFrom(rel) };
}

/**
 * Who was running when a file's unsure changes happened: every candidate of every moment (an entry's `ids`, even when
 * the other candidates' entries were replaced since), and whether all of them were background commands only (maybes).
 */
export function runningAt(by: readonly ChangeBy[]): { sessions: number; background: boolean } {
  return { sessions: new Set(by.flatMap((b) => b.ids ?? [b.terminalId])).size, background: by.length > 0 && by.every((b) => b.maybe) };
}

/** When a file's unsure changes happened, as far as known: distinct times, oldest first. */
export function changeTimes(by: readonly ChangeBy[]): number[] {
  return [...new Set(by.map((b) => b.changedAt).filter((x): x is number => x !== undefined))].sort((a, b) => a - b);
}

/** The rows that say where a session works: its sure files, else its unsure ones. */
export function locationRows<R>(g: { rows: R[]; maybe: R[] }): R[] {
  return g.rows.length > 0 ? g.rows : g.maybe;
}

/** The other rows whose file changed in the same moment as `row`'s (resolved together by default). */
export function sameMoment(rows: readonly ChangeRow[], row: ChangeRow): ChangeRow[] {
  const key = momentKey(row);
  return key === null ? [] : rows.filter((r) => r.path !== row.path && momentKey(r) === key);
}

export function groupByRepo(rows: ChangeRow[], repos: RepoStatus[]) {
  return repos.filter((r) => r.changes.length > 0).map((repo) => ({ repo, rows: rows.filter((x) => x.repo === repo.root) }));
}

export function cleanRepos(repos: RepoStatus[]): RepoStatus[] {
  return repos.filter((r) => r.changes.length === 0 && !r.error);
}

/** How many clean repositories Changes names before it only counts the rest: what fits the panel at its usual size. */
export const CHANGES_CAP = 12;

/**
 * The items a list shows before "N more": the first `max` in their order, plus any later one `keep` wants shown (a
 * repository a live session works in), in its place.
 */
export function capShown<T>(items: readonly T[], max: number, keep: (x: T) => boolean): { shown: T[]; more: number } {
  const shown = items.filter((x, i) => i < max || keep(x));
  return { shown, more: items.length - shown.length };
}

/** The repositories a live session works in: the deepest one around each session's folder. */
export function sessionRoots(roots: readonly string[], terminals: readonly { cwd: string; session?: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const x of terminals) {
    if (!x.session) continue;
    let best: string | null = null;
    for (const r of roots) if ((x.cwd === r || isBelow(r, x.cwd)) && (!best || r.length > best.length)) best = r;
    if (best) out.add(best);
  }
  return out;
}

/**
 * The repositories git refuses to read (another user's folder: safe.directory), a row each in Changes. Other read
 * failures (a timeout under load, a repo mid-gc) pass with the next read: no row for them (Source Control shows the
 * error); like these, they are never counted as clean (cleanRepos).
 */
export function unreadableRepos(repos: RepoStatus[]): RepoStatus[] {
  return repos.filter((r) => !!dubiousOwnership(r.error));
}

/**
 * One group per session: `rows`, the files it surely changed (exact, alone in a command, or as the user said), and
 * `maybe`, the files it is only one candidate for. Unknown origin last.
 */
export function groupBySession(rows: ChangeRow[], unknownLabel = 'Unknown origin') {
  const groups = new Map<string, { key: string; title: string; color: string | null; rows: ChangeRow[]; maybe: ChangeRow[] }>();
  const unknown: ChangeRow[] = [];
  for (const r of rows) {
    if (r.by.length === 0) { unknown.push(r); continue; }
    for (const b of r.by) {
      const g = groups.get(b.terminalId) ?? { key: b.terminalId, title: b.title, color: b.color, rows: [], maybe: [] };
      const into = isUnsure(b) ? g.maybe : g.rows;
      if (!into.includes(r)) into.push(r);
      groups.set(b.terminalId, g);
    }
  }
  const out = [...groups.values()];
  if (unknown.length) out.push({ key: 'unknown', title: unknownLabel, color: null, rows: unknown, maybe: [] });
  return out;
}

/**
 * The sessions that surely touched a file: unclear entries (one of several candidates) and maybe ones (a background
 * command, or someone outside Claude) left out.
 */
export const sureBy = (by: readonly ChangeBy[]): ChangeBy[] => by.filter((b) => !b.unclear && !b.maybe);

/** Files two sessions really touched: unclear and maybe entries do not count. */
export function overlaps(rows: ChangeRow[]): ChangeRow[] {
  return rows.filter((r) => new Set(sureBy(r.by).map((b) => b.terminalId)).size >= 2);
}

/**
 * The order in which warnings name sessions: the open sessions by creation time (then id), as one string so a store
 * selector returning it only re-renders when the order really changes. `split('\n')` gives the ids.
 */
export function sessionOrderKey(terminals: readonly { id: string; createdAt: number }[]): string {
  return [...terminals].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((x) => x.id).join('\n');
}

/**
 * One entry per session, in `order` (terminal ids, from sessionOrderKey); sessions no longer open go last, by name
 * then id. Never by edit time: two sessions editing in the same instant would swap places run to run, and every new
 * edit would reshuffle the names of a warning that hasn't changed.
 */
export function inSessionOrder(by: readonly ChangeBy[], order: readonly string[]): ChangeBy[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const rank = (b: ChangeBy) => pos.get(b.terminalId) ?? Number.POSITIVE_INFINITY;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return by.filter((b, i) => by.findIndex((x) => x.terminalId === b.terminalId) === i)
    .sort((a, b) => (rank(a) - rank(b)) || cmp(a.title, b.title) || cmp(a.terminalId, b.terminalId));
}

/** Overlap warnings: one per group of sessions touching the same files (not one card per file), with every name. */
export function overlapGroups(rows: ChangeRow[], order: readonly string[]): { key: string; by: ChangeBy[]; rows: ChangeRow[] }[] {
  const groups = new Map<string, { key: string; by: ChangeBy[]; rows: ChangeRow[] }>();
  for (const r of overlaps(rows)) {
    const by = inSessionOrder(sureBy(r.by), order);
    const key = by.map((b) => b.terminalId).sort().join('|');
    const g = groups.get(key) ?? { key, by, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** The names on a Review row's overlap chip, in session order; fewer than two sessions for sure: none (no chip). */
export function clashNames(row: ChangeRow, order: readonly string[]): string[] {
  const by = inSessionOrder(sureBy(row.by), order);
  return by.length >= 2 ? by.map((b) => b.title) : [];
}

/** A same-file notice's chips: each file by its name, with as much of its folder as tells two of the same name apart. */
export function clashChipLabels(rels: string[]): string[] {
  const parts = rels.map((r) => r.split('/'));
  const tail = (p: string[], d: number) => p.slice(-d).join('/');
  return parts.map((p, i) => {
    let d = 1;
    while (d < p.length && parts.some((q, j) => j !== i && tail(q, d) === tail(p, d))) d++;
    return tail(p, d);
  });
}

/** How many chips a same-file notice shows before "+N more": all of five, four of more. */
export function clashChipsShown(n: number): number {
  return n <= 5 ? n : 4;
}

/**
 * A same-file avatar's tooltip: the title, its state and where it works, what a click does; closed (null): just that.
 * 'paused': at a usage limit, "Usage limit".
 */
export function clashSessionTip(title: string, state: SessionState | 'starting' | 'paused' | null, where: string | null): string {
  if (!state) return `${title}\n${t.clash.closed}`;
  const label = state === 'starting' ? t.starting : state === 'paused' ? t.limit.label : t.stateLabel[state];
  return `${title}\n${[label, where].filter(Boolean).join(' · ')}\n${t.clash.goTo}`;
}

/** "Alfa and Beta both touched" / "Alfa, Beta and Gamma all touched". */
export function touchedBy(names: string[]): string {
  if (names.length <= 2) return t.bothTouched(names[0] ?? '', names[1] ?? '');
  return t.allTouched(`${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
}

/** The files of a warning: the first three, then how many more. */
export function fileList(files: string[], shown = 3): string {
  return files.length <= shown ? files.join(', ') : `${files.slice(0, shown).join(', ')} and ${files.length - shown} more`;
}
