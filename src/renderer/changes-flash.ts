// Which Changes rows flash in. Pure: the panel keeps the baseline between lists.

export interface FlashBaseline {
  project: string;
  /** Repos already seen: a repo's first list is its baseline (loading or adding one flashes nothing). */
  repos: Set<string>;
  /** Paths in the list last shown. */
  paths: Set<string>;
}

/**
 * The paths that are new since the last list, and the baseline for the next one. The first list (no baseline, or
 * another project) and the first list of each repo flash nothing. `repos`: every repo shown, with or without rows
 * (an empty repo seen first makes its first file flash); defaults to the rows' repos.
 */
export function nextFlash(prev: FlashBaseline | null, rows: readonly { path: string; repo: string }[], project: string,
  repos: readonly string[] = rows.map((x) => x.repo)): { fresh: Set<string>; baseline: FlashBaseline } {
  const same = prev !== null && prev.project === project;
  const fresh = new Set<string>();
  for (const x of rows) if (same && prev.repos.has(x.repo) && !prev.paths.has(x.path)) fresh.add(x.path);
  const seen = new Set(same ? prev.repos : []);
  for (const root of repos) seen.add(root);
  for (const x of rows) seen.add(x.repo);
  return { fresh, baseline: { project, repos: seen, paths: new Set(rows.map((x) => x.path)) } };
}

/** A collapsed group with one of its rows (nested worktrees and unsure ones included) flashing: that row, else null. */
export function collapsedFlash<R extends { path: string }>(rows: readonly R[], flashing: ReadonlyMap<string, number>, open: boolean): R | null {
  if (open) return null;
  return rows.find((r) => flashing.has(r.path)) ?? null;
}

/**
 * How far into its flash a row is, as a negative animation delay (ms): a row remounted mid-flash (it moved group when
 * its attribution settled) carries on from there instead of starting over.
 */
export function flashOffset(since: number, now: number): number {
  return Math.min(0, since - now);
}
