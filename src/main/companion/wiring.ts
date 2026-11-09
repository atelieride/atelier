// Ask companion: what main hands the service from what the app already knows — the
// account a run uses, and the facts it is told about the session (state, what it waits for, its files, lines, cost,
// branch, model). Pure: index.ts passes the terminal list, the attributions and the git statuses.
import { isUnsure, type Attribution } from '@shared/attribution';
import { accountById, accountOf, launchDir, type ClaudeAccounts } from '@shared/claude-accounts';
import { liveFacts } from '@shared/companion/live';
import type { Binding } from '@shared/companion/types';
import { isBelow, isInside, trimOneSep } from '@shared/paths';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { waitKind } from '@shared/session-view';
import type { CompanionDeps } from './service';

/**
 * The config dir a run uses (null: the default account, never named explicitly): 'session' → the session's own; an
 * account → its launch dir; an id no longer configured → the session's own too. The session's own counts only as a
 * configured account's (the IPC already maps it so): any other dir is the default account, never put in an environment.
 */
export function companionAccountDir(a: ClaudeAccounts, defaultDir: string, choice: string, sessionConfigDir: string | null): string | null {
  const acc = choice === 'session' ? null : accountById(a, choice);
  if (acc) return launchDir(acc) ?? null;
  const own = accountOf(sessionConfigDir, a, defaultDir);
  return own ? launchDir(own) ?? null : null;
}

/**
 * The files a session changed in the project (exact attribution): project-relative, the newest time per path, oldest
 * first. Unsure ones (several candidates, a background command's maybe) are left out: Ask is told facts only.
 * `projectReal`: the project's real path (attributions carry real paths).
 */
export function sessionFiles(attributions: readonly Attribution[], projectReal: string, sessionId: string): { rel: string; at: number }[] {
  const root = trimOneSep(projectReal);
  const newest = new Map<string, number>();
  for (const a of attributions) {
    if (a.sessionId !== sessionId || isUnsure(a) || !isBelow(root, a.path)) continue;
    const rel = a.path.slice(root.length + 1);
    newest.set(rel, Math.max(newest.get(rel) ?? a.at, a.at));
  }
  return [...newest].map(([rel, at]) => ({ rel, at })).sort((x, y) => x.at - y.at || (x.rel < y.rel ? -1 : 1));
}

/** The branch of the deepest repository holding the folder (a worktree inside the project wins); null without one. */
export function branchAt(statuses: Iterable<{ root: string; branch: string | null }>, cwd: string): string | null {
  let best: { root: string; branch: string | null } | null = null;
  for (const s of statuses) if (isInside(s.root, cwd) && (!best || s.root.length > best.root.length)) best = s;
  return best?.branch ?? null;
}

/** What the session waits for, from its activity ("waiting: Bash npm test" → "permission: Bash npm test"). */
function waitingFor(s: SessionInfo): string | null {
  const kind = waitKind(s);
  if (kind === null) return null;
  const what = (s.activity ?? '').replace(/^waiting(?::\s*|\s+for you$)/, '').trim();
  const label = kind === 'question' ? 'an answer to its question' : kind === 'permission' ? 'permission' : 'you';
  return what ? `${label}: ${what}` : label;
}

/**
 * The service's facts for a binding. Its terminal counts only while it still runs that session: one that ended (or
 * whose terminal now runs another Claude) is 'ended', its files still told. Main doesn't track since when a state
 * holds (the panel's live strip does): `since` stays null.
 */
export function companionFacts(term: TerminalInfo | null, b: Binding, o: { files: { rel: string; at: number }[]; branch: string | null; now: number }): ReturnType<CompanionDeps['facts']> {
  const session = term?.session?.sessionId === b.sessionId ? term.session : null;
  const live = term && session ? term : null;
  return {
    facts: liveFacts(live, { since: null, files: o.files.length, now: o.now }),
    waiting: session ? waitingFor(session) : null,
    files: o.files,
    costUsd: session?.cost?.usd ?? null,
    branch: o.branch,
    model: session?.model ?? null
  };
}
