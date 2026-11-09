import { z } from 'zod';

/**
 * The pull request of a Claude session's branch and its CI. Main runs
 * `gh pr view <branch> --json number,title,url,state,isDraft,reviewDecision,statusCheckRollup` and parses it here: only
 * the fields below survive (unknown ones are dropped), the title is truncated, the URL must be https, and the rollup is
 * reduced to a summary (counts and up to three failing names) — no check list ever leaves main.
 */
export const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup';
export const MAX_TITLE = 200;
export const MAX_CHECK_NAME = 100;
export const MAX_FAILING_NAMES = 3;

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface CiSummary {
  /** failing > pending > passing; none without checks. */
  state: 'passing' | 'failing' | 'pending' | 'none';
  passed: number;
  failed: number;
  pending: number;
  /** Names of the first failing checks (at most three). */
  failing: string[];
}

export interface PrInfo {
  number: number;
  title: string;
  /** https only (checked when parsed); main opens it, never a URL from the renderer. */
  url: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: ReviewDecision | null;
  ci: CiSummary;
}

/** What main knows about one repo+branch, as sent to the windows. */
export type PrEntry =
  | { root: string; branch: string; status: 'ok'; pr: PrInfo }
  | { root: string; branch: string; status: 'none' | 'missing' | 'auth' };

/** The GitHub CLI as last seen by main: Settings explains `missing` and `auth`. */
export type GhStatus = 'ok' | 'missing' | 'auth' | 'unknown';

/** Sent to each window for its project: terminal id → the PR of its session's branch (absent: nothing to show). */
export interface PrsState { gh: GhStatus; terminals: Record<string, PrEntry> }

export const EMPTY_PRS: PrsState = { gh: 'unknown', terminals: {} };

/** One cache entry per repo root and branch (a newline cannot appear in either). */
export const prKey = (root: string, branch: string) => `${root}\n${branch}`;

/** GitHub's checks page of a PR. */
export const checksUrl = (url: string) => `${url.replace(/\/+$/, '')}/checks`;

const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILED_CONTEXT = new Set(['FAILURE', 'ERROR']);
const PENDING_CONTEXT = new Set(['PENDING', 'EXPECTED']);

const checkRun = z.object({ __typename: z.literal('CheckRun'), name: z.string().catch(''), status: z.string().catch(''), conclusion: z.string().nullish().catch(null) });
const statusContext = z.object({ __typename: z.literal('StatusContext'), context: z.string().catch(''), state: z.string().catch('') });
const check = z.union([checkRun, statusContext]);
type Check = z.infer<typeof check>;

/** CI summary of a `statusCheckRollup` (entries that are neither a CheckRun nor a StatusContext are ignored). */
export function ciSummary(rollup: readonly unknown[]): CiSummary {
  let passed = 0, failed = 0, pending = 0;
  const failing: string[] = [];
  for (const raw of rollup) {
    const parsed = check.safeParse(raw);
    if (!parsed.success) continue;
    const c: Check = parsed.data;
    let kind: 'pass' | 'fail' | 'pending';
    if (c.__typename === 'CheckRun') {
      kind = c.status !== 'COMPLETED' ? 'pending' : FAILED_RUN.has(c.conclusion ?? '') ? 'fail' : 'pass';
    } else {
      kind = FAILED_CONTEXT.has(c.state) ? 'fail' : PENDING_CONTEXT.has(c.state) ? 'pending' : 'pass';
    }
    if (kind === 'pass') passed++;
    else if (kind === 'pending') pending++;
    else {
      failed++;
      const name = c.__typename === 'CheckRun' ? c.name : c.context;
      if (failing.length < MAX_FAILING_NAMES) failing.push(name.slice(0, MAX_CHECK_NAME));
    }
  }
  const state = failed ? 'failing' : pending ? 'pending' : passed ? 'passing' : 'none';
  return { state, passed, failed, pending, failing };
}

const httpsUrl = z.string().max(2048).refine((u) => {
  if (!u.startsWith('https://') || /[\s\u0000-\u001f\u007f]/.test(u)) return false;
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
});

const ghPrSchema = z.object({
  number: z.number().int().positive().max(1e9),
  title: z.string().transform((s) => [...s].slice(0, MAX_TITLE).join('')),
  url: httpsUrl,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean().catch(false),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullish().catch(null).transform((v) => v ?? null),
  statusCheckRollup: z.array(z.unknown()).nullish().catch(null)
});

/** gh's JSON for one PR, or null when it is not a PR we can show. */
export function parseGhPr(stdout: string): PrInfo | null {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return null; }
  const r = ghPrSchema.safeParse(json);
  if (!r.success) return null;
  const { statusCheckRollup, ...pr } = r.data;
  return { ...pr, ci: ciSummary(statusCheckRollup ?? []) };
}
