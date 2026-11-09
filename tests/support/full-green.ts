// The full-green stamp: `<git common dir>/atelier-e2e-full-green` holds the HEAD of the last
// green run of the whole suite on a clean tree. `npm run release` asks for a full run when the app changed since;
// `npm run e2e:affected` reminds when it is getting old. Pure decisions here, the reporter does the git.
import { readFileSync, writeFileSync } from 'node:fs';

export interface Stamp { sha: string; at: string }

/** CLI flags that run less than the whole suite (or nothing: --list) while every file may still appear in it. */
const FILTERS = ['--grep-invert', '--grep', '--shard', '--list', '--last-failed', '--only-changed', '--test-list', '-g'];

export interface RunFacts {
  status: string;
  /** Spec files the run included. */
  ran: string[];
  /** Every spec file of the suite. */
  allSpecs: string[];
  argv: string[];
  /** Uncommitted paths when the run started. */
  dirty: string[];
  /** Tests in the suite, and tests that produced a result (onTestEnd). */
  tests: number;
  results: number;
  /** The HEAD npm run e2e / e2e:affected built from a clean tree (ATELIER_E2E_BUILT_HEAD), null when unset. */
  built: string | null;
  /** HEAD when the run started and when it ended. */
  head: string | null;
  headAtEnd: string | null;
}

/** `why` is null for a run that wasn't meant as a full one (said nothing: most runs are partial). */
export function stampDecision(f: RunFacts): { stamp: true } | { stamp: false; why: string | null } {
  const ran = new Set(f.ran);
  if (!f.allSpecs.length || !f.allSpecs.every((s) => ran.has(s))) return { stamp: false, why: null };
  const flag = f.argv.map((a) => FILTERS.find((x) => a === x || a.startsWith(`${x}=`) || (x === '-g' && a.startsWith('-g')))).find(Boolean);
  if (flag) return { stamp: false, why: `filtered (${flag})` };
  if (f.status !== 'passed') return { stamp: false, why: 'the run was not green' };
  if (f.results < f.tests) return { stamp: false, why: `only ${f.results} of ${f.tests} tests ran` };
  if (f.dirty.length) return { stamp: false, why: `uncommitted changes when it started (${f.dirty.join(', ')})` };
  if (!f.built) return { stamp: false, why: 'not built by npm run e2e (no ATELIER_E2E_BUILT_HEAD)' };
  if (f.built !== f.head) return { stamp: false, why: `HEAD moved since the build (built ${f.built.slice(0, 7)}, now ${(f.head ?? 'none').slice(0, 7)})` };
  if (f.headAtEnd !== f.head) return { stamp: false, why: 'HEAD moved during the run' };
  return { stamp: true };
}

/** Green full runs kept: a green run on a branch or worktree doesn't push main's out. */
const KEEP = 10;

const isStamp = (v: unknown): v is Stamp =>
  !!v && typeof (v as Stamp).sha === 'string' && /^[0-9a-f]{4,64}$/.test((v as Stamp).sha) && typeof (v as Stamp).at === 'string';

/** The recorded green full runs, newest first (a one-run file from before is read as one run). */
export function readStamps(path: string): Stamp[] {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (isStamp(v)) return [v];
    const runs = (v as { runs?: unknown }).runs;
    return Array.isArray(runs) ? runs.filter(isStamp) : [];
  } catch {
    return [];
  }
}

export function writeStamp(path: string, sha: string, at: string): void {
  const runs = [{ sha, at }, ...readStamps(path).filter((s) => s.sha !== sha)].slice(0, KEEP);
  writeFileSync(path, JSON.stringify({ runs }));
}
