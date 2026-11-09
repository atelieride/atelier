import type { GitOpResult, GitOutcome } from '@shared/git-write';
import { MESSAGE_LINE_MAX, classifyFetch, fetchMessage, scrubCredentials } from './fetch';
import { type Invocation, type RawRun, isServerHook } from './write';

/**
 * How a write op ended, from its exit, trace2's hook signals and git's own words. Rules checked
 * on the real output of git 2.54 (__fixtures__/write-*.txt). The message is git's first meaningful line, scrubbed like
 * fetch's (fetchMessage), at most 200 characters; the full output is kept for "Full log", credentials removed.
 */

// Ordered: the first that matches wins.
const STALE = /\(stale info\)/;
// git's files backend: a ref can't be both a branch and a branch's folder (refs/heads/feat and refs/heads/feat/x).
const REF_CLASH = /'(refs\/[^'\n]+)' exists; cannot create '(refs\/[^'\n]+)'/;
const REMOTE_REF = /^refs\/remotes\/([^/]+)\/(.+)$/;

/**
 * Local branches: the new name is the user's to change. Remote-tracking ones (a pull or fetch): a branch the remote
 * deleted, never pruned here, stands in the way of a new one in its folder.
 */
function clashMessage(exists: string, wanted: string): string {
  const a = REMOTE_REF.exec(exists); const b = REMOTE_REF.exec(wanted);
  if (a && b) return `${a[1]}/${a[2]}, gone from the remote, is still here and stands in the way of ${b[1]}/${b[2]}: run git remote prune ${a[1]}, then try again`;
  const short = (ref: string) => ref.replace(/^refs\/(?:heads|remotes)\//, '');
  return `A branch named ${short(exists)} exists, so ${short(wanted)} can't be made: pick another name`;
}
const REJECTED = /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)|Updates were rejected because/;
const SIGN = /gpg failed to sign|failed to sign the data|Inappropriate ioctl for device|signing failed|Couldn't sign|Couldn't load public key|No secret key|error: Load key|ssh-keygen[^\n]*(?:failed|error)/i;
const IDENTITY = /Please tell me who you are|Author identity unknown|Committer identity unknown|empty ident name|unable to auto-detect email address|no (?:email|name) was given and auto-detection is disabled|invalid ident/i;
const STATE = /not possible because you have unmerged files|you have unmerged (?:files|paths)|You have not concluded your (?:merge|cherry-pick|revert)|you need to resolve your current index first|in the middle of (?:a |an )?(?:merge|rebase|am|cherry-pick|revert)|rebase-(?:merge|apply) directory|cannot do a partial commit during a merge/i;
const DIRTY = /would be overwritten by (?:merge|checkout|switch)|already exists, no checkout|cannot (?:pull with rebase|rebase): (?:You have unstaged changes|Your index contains uncommitted changes)/i;
const CONFLICT = /^CONFLICT \(|could not apply|Merge conflict in|is not fully merged|Conflicts in index/im;
const NOTHING = /nothing to commit|nothing added to commit|no changes added to commit/;
const STASH_STALE = /is not a valid reference|No stash entries found|is not a stash-like commit/i;
const STASH_NOTHING = /^No local changes to save/m;
const GIT_ERROR = /^(?:fatal|error):/m;

/** git lines that say nothing on their own: the next meaningful one is the message. */
const GENERIC = /^(?:error: failed to push some refs|error: Please commit or stash them|fatal: Could not read from remote repository|fatal: Exiting because of an unresolved conflict)/i;
const NOISE = /^(?:hint:|To |From |Auto-merging |Rebasing \(|On branch |Your branch |Aborting$|Updating [0-9a-f]+\.\.|[0-9a-f]+\.\.[0-9a-f]+ |\* \[new |Index was not unstashed|The stash entry is kept)/;

/** https://user:token@host/… → https://host/… (fetchMessage's rule, applied to the whole output for "Full log"). */
const scrub = scrubCredentials;

/** The output's lines, each cut to 4 KB (a message is at most 200 characters anyway), blanks gone. */
function lines(output: string): string[] {
  return output.split(/\r\n|\r|\n/).map((l) => l.slice(0, MESSAGE_LINE_MAX).replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** git's first meaningful line: an error line, else the remote's words, else the line `re` matched, else any. */
function message(output: string, re?: RegExp): string {
  const ls = lines(output);
  const line = ls.find((l) => /^(?:fatal|error):/i.test(l) && !GENERIC.test(l))
    ?? ls.find((l) => /^remote:\s*\S/.test(l))?.replace(/^remote:\s*/, '')
    ?? (re ? ls.find((l) => re.test(l)) : undefined)
    ?? ls.find((l) => !NOISE.test(l) && !GENERIC.test(l))
    ?? '';
  return fetchMessage(line);
}

/** A failed hook speaks last: its final line (husky's "pre-commit script failed", lint-staged's summary). */
function hookMessage(output: string, hook: string | undefined): string {
  const ls = lines(output).filter((l) => !/^hint:/i.test(l));
  const last = ls[ls.length - 1];
  return last ? fetchMessage(last) : `The ${hook ?? 'commit'} hook failed.`;
}

/** Files listed under "would be overwritten by …:" (tab-indented) or "<file> already exists, no checkout". */
function dirtyFiles(output: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const raw of output.split(/\r\n|\r|\n/)) {
    if (/would be overwritten by [a-z]+:$/.test(raw)) { inList = true; continue; }
    if (inList && raw.startsWith('\t')) { files.push(raw.slice(1)); continue; }
    inList = false;
    const m = /^(.+) already exists, no checkout$/.exec(raw);
    if (m) files.push(m[1]!);
  }
  return [...new Set(files)];
}

/** Files with conflict markers: "CONFLICT (…): Merge conflict in <file>". */
function conflictFiles(output: string): string[] {
  const files = [...output.matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm)].map((m) => m[1]!);
  return [...new Set(files)];
}

export function classifyWrite(inv: Invocation, run: RawRun, o: { hooksExist: boolean }): GitOpResult {
  const output = scrub(run.output);
  const base: Partial<GitOpResult> = {};
  if (output) base.output = output;
  if (run.lastHook) base.hook = run.lastHook;
  const res = (outcome: GitOutcome, extra: Partial<GitOpResult> = {}): GitOpResult => ({ outcome, ...base, ...extra });

  if (run.cancelled) return res('cancelled', { message: 'Cancelled.' });
  if (run.timedOut && run.hookRunning) return res('error', { hook: run.hookRunning, message: `The ${run.hookRunning} hook did not finish in time.` });
  if (run.timedOut) return inv.network ? res('network', { message: 'The remote did not answer in time.' }) : res('error', { message: 'Git did not finish in time.' });
  // Output past the cap was dropped (runWrite noted it), never a reason to stop git: the exit code decides.
  if (run.code === 0) {
    // stash push exits 0 when there is nothing to save: no stash was made.
    if (inv.op === 'stashPush' && STASH_NOTHING.test(output)) return res('nothing', { message: 'No local changes to save' });
    return res('ok');
  }
  if (run.hookFailed && !isServerHook(run.hookFailed)) return res('hook', { hook: run.hookFailed, message: hookMessage(output, run.hookFailed) });

  // A new name clashing with a branch's folder (feat and feat/x): "cannot lock ref" too, but no lock will free it.
  const clash = REF_CLASH.exec(output);
  if (clash) return res('error', { message: clashMessage(clash[1]!, clash[2]!) });
  const fetchLike = classifyFetch(output);
  if (fetchLike === 'busy') return res('busy', { message: message(output) });
  if (inv.network && (fetchLike === 'auth' || fetchLike === 'network')) return res(fetchLike, { message: fetchMessage(output) });
  if (STALE.test(output)) return res('stale', { message: message(output, STALE) });
  if (REJECTED.test(output)) return res('rejected', { message: message(output, REJECTED) });
  if (SIGN.test(output)) return res('sign', { message: message(output, SIGN) });
  if (IDENTITY.test(output)) return res('identity', { message: message(output, IDENTITY) });
  if (STATE.test(output)) return res('state', { message: message(output, STATE) });
  if (DIRTY.test(output)) {
    const files = dirtyFiles(output);
    return res('conflict', { dirty: true, message: message(output, DIRTY), ...(files.length ? { files } : {}) });
  }
  if (CONFLICT.test(output)) {
    const files = conflictFiles(output);
    return res('conflict', { message: message(output, CONFLICT), ...(files.length ? { files } : {}) });
  }
  if (inv.op === 'commit' && NOTHING.test(output)) return res('nothing', { message: message(output, NOTHING) });
  if (inv.op.startsWith('stash') && STASH_STALE.test(output)) return res('stale', { message: message(output, STASH_STALE) });
  // No trace2 (old git, socket error): a failure git said nothing about is the hook's.
  if (!run.traced && o.hooksExist && !GIT_ERROR.test(output)) return res('hook', { message: hookMessage(output, run.lastHook) });
  return res('error', { message: message(output) || `git exited with ${run.code ?? 'a signal'}` });
}
