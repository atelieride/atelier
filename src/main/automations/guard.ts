// The git guard of automated sessions. The session's
// environment points every git process it starts at these hooks (GIT_CONFIG_* → core.hooksPath) and rewrites every push
// URL to a scheme that doesn't exist (pushInsteadOf), so neither `git -C`, `bash -c`, `--no-verify` nor another folder
// gets around it. Only the run's own branch may move; the repository's own hooks still run, chained.
//
// Nothing in the user's repository changes. A determined process can unset the environment: the guard stops mistakes and
// casual prompt injections, not an adversary (said in the Turn On sheet).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validBranchName } from '@shared/git-write';
import { currentPlatform } from '@shared/platform';

/** Every client-side hook git runs; the guard owns them all, so the user's own are reached only through it. */
export const GUARD_HOOK_NAMES: readonly string[] = Object.freeze([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg',
  'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite',
  'sendemail-validate', 'post-index-change', 'reference-transaction'
]);

/** The scheme every push URL becomes: git finds no helper for it and stops, whatever the flags. */
const NO_PUSH = 'atelier-automated-sessions-never-push://blocked/';

/** The repository's own hook folder: ATELIER_USER_HOOKS (its core.hooksPath, read by the launcher) or <common dir>/hooks. */
const USER_HOOK = (name: string) => `user_hook() {
  dir="\${ATELIER_USER_HOOKS:-}"
  [ -n "$dir" ] || dir="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
  h="$dir/${name}"
  [ -x "$h" ] && [ ! "$h" -ef "$0" ]
}`;

const chain = (name: string) => `#!/bin/sh
# Atelier automation guard: runs the repository's own ${name} hook, if it has one.
${USER_HOOK(name)}
user_hook && exec "$h" "$@"
exit 0
`;

const REFERENCE_TRANSACTION = `#!/bin/sh
# Atelier automation guard: in an automated session only the run's own branch may move (no other branch, no tag, no
# stash: refs/stash is shared with the user's checkout).
input=$(cat)
if [ "$1" = prepared ]; then
  printf '%s\\n' "$input" | while read -r old new ref; do
    case "$ref" in
      "refs/heads/$ATELIER_RUN_BRANCH") ;;
      refs/stash)
        echo "Atelier: an automated session doesn't use git stash: the stash is shared with your checkout." >&2
        exit 1 ;;
      refs/heads/*|refs/tags/*)
        echo "Atelier: this automated session may only change its own branch ($ATELIER_RUN_BRANCH), not $ref. Merging is up to you, from Atelier's Source Control." >&2
        exit 1 ;;
    esac
  done || exit 1
fi
${USER_HOOK('reference-transaction')}
if user_hook; then printf '%s\\n' "$input" | "$h" "$@" || exit $?; fi
exit 0
`;

const PRE_PUSH = `#!/bin/sh
# Atelier automation guard: automated sessions never push.
echo "Atelier: automated sessions never push. Push from Atelier's Source Control." >&2
exit 1
`;

/**
 * The session's `git` (first on its PATH): a fast-forward merge writes the work tree before its ref, so the hooks alone
 * would leave the project's own checkout changed though no branch moved. This refuses any git command whose work tree —
 * after every -C, --work-tree, GIT_WORK_TREE, or the shell's cd — is inside the project but outside the run's worktree,
 * before git reads or writes anything, then runs the real git (the next one on PATH). A folder outside the project is
 * free (a scratch clone). It refuses `push` whatever the remote (a pushurl or an ssh host alias escapes pushInsteadOf)
 * and `stash` but list and show (the stash is the user's too). Only an absolute path to git gets around it; the hooks
 * still hold the refs then.
 */
const GIT_SHIM = `#!/bin/sh
# Atelier automation guard: an automated session's git works in its own worktree only.
self=$(cd "$(dirname "$0")" && pwd -P)
real=""
old_ifs=$IFS; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$(cd "$d" 2>/dev/null && pwd -P)" = "$self" ] && continue
  if [ -x "$d/git" ]; then real="$d/git"; break; fi
done
IFS=$old_ifs
[ -n "$real" ] || { echo "Atelier: git isn't available in this automated session." >&2; exit 127; }
dir=$PWD
tree=\${GIT_WORK_TREE:-}
gitdir=\${GIT_DIR:-}
index=\${GIT_INDEX_FILE:-}
next=""
sub=""
sub2=""
# git's own options before the command (git.c): those that take a value, those that don't; anything else is refused,
# so no value is ever taken for the command and no -C hides behind it.
for a in "$@"; do
  if [ -n "$sub" ]; then sub2=$a; break; fi
  if [ -n "$next" ]; then
    case "$next" in
      C) case "$a" in /*) dir=$a ;; *) dir="$dir/$a" ;; esac ;;
      tree) tree=$a ;;
      gitdir) gitdir=$a ;;
    esac
    next=""; continue
  fi
  case "$a" in
    -C) next=C ;;
    --work-tree=*) tree=\${a#--work-tree=} ;;
    --work-tree) next=tree ;;
    --git-dir=*) gitdir=\${a#--git-dir=} ;;
    --git-dir) next=gitdir ;;
    -c|--namespace|--config-env|--super-prefix|--attr-source|--shallow-file) next=skip ;;
    --namespace=*|--config-env=*|--super-prefix=*|--attr-source=*|--exec-path=*|--list-cmds=*) ;;
    -p|--paginate|-P|--no-pager|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--bare|--literal-pathspecs|\
--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--html-path|--man-path|--info-path|-v|--version|-h|--help|--exec-path) ;;
    -*)
      echo "Atelier: an automated session's git doesn't take $a before its command." >&2
      exit 1 ;;
    *) sub=$a ;;
  esac
done
case "$sub" in
  push|send-pack)
    echo "Atelier: automated sessions never push. Push from Atelier's Source Control." >&2
    exit 1 ;;
  stash)
    case "$sub2" in
      list|show) ;;
      *)
        echo "Atelier: an automated session doesn't use git stash: the stash is shared with your checkout. Commit work in progress on the run's branch instead." >&2
        exit 1 ;;
    esac ;;
esac
if [ -n "\${ATELIER_RUN_WORKTREE:-}" ] && [ -n "\${ATELIER_RUN_PROJECT:-}" ]; then
  wt=$(cd "$ATELIER_RUN_WORKTREE" 2>/dev/null && pwd -P) || wt=$ATELIER_RUN_WORKTREE
  proj=$(cd "$ATELIER_RUN_PROJECT" 2>/dev/null && pwd -P) || proj=$ATELIER_RUN_PROJECT
  target=$dir
  if [ -n "$tree" ]; then case "$tree" in /*) target=$tree ;; *) target="$dir/$tree" ;; esac; fi
  phys=$(cd "$target" 2>/dev/null && pwd -P) || phys=$target
  case "$phys/" in
    "$wt/"*) ;;
    "$proj/"*)
      echo "Atelier: an automated session works only in its own worktree ($wt), not in $phys. Merging is up to you, from Atelier's Source Control." >&2
      exit 1 ;;
  esac
  # An explicit git folder or index (git sets GIT_DIR for hooks): the run's own only — its worktree's .git folder, or
  # the one its .git file names — never the checkout's, whose index and HEAD it would write.
  admin=""
  if [ -d "$wt/.git" ]; then admin="$wt/.git"
  elif [ -f "$wt/.git" ]; then
    admin=$(sed -n 's/^gitdir: //p' "$wt/.git" | head -n 1)
    case "$admin" in /*|"") ;; *) admin="$wt/$admin" ;; esac
  fi
  admin=$(cd "$admin" 2>/dev/null && pwd -P) || admin=""
  [ -n "$admin" ] || admin="/nonexistent/atelier-admin"
  for g in "$gitdir" "$index"; do
    [ -n "$g" ] || continue
    case "$g" in /*) gp=$g ;; *) gp="$dir/$g" ;; esac
    if [ -d "$gp" ]; then gp=$(cd "$gp" && pwd -P); else gp="$(cd "$(dirname "$gp")" 2>/dev/null && pwd -P)/$(basename "$gp")"; fi
    case "$gp/" in
      "$admin/"*) ;;
      "$proj/"*)
        echo "Atelier: an automated session uses only its own worktree's git folder, not $gp." >&2
        exit 1 ;;
    esac
  done
fi
exec "$real" "$@"
`;

/** Each hook's script. */
export function guardHooks(): Record<string, string> {
  return Object.fromEntries(GUARD_HOOK_NAMES.map((n) => [n, n === 'reference-transaction' ? REFERENCE_TRANSACTION : n === 'pre-push' ? PRE_PUSH : chain(n)]));
}

/**
 * Writes the hooks into `dir` (0700, each hook 0700), only the ones whose content differs; true when it wrote any.
 * Main calls it at start (ATELIER_HOME/automations/guard). The session's git: the sh script on macOS; on Windows
 * a copy of the app's own atelier-git.exe (`gitExe`), which every shell finds as git.exe — none when the
 * build has no binary (launch then refuses).
 */
export function writeGuard(dir: string, o: { gitExe?: string | null } = {}): boolean {
  const windows = currentPlatform() === 'win32';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let wrote = false;
  mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 });
  chmodSync(join(dir, 'bin'), 0o700);
  for (const [name, text] of [...Object.entries(guardHooks()), ...(windows ? [] : [['bin/git', GIT_SHIM] as const])]) {
    const file = join(dir, name);
    let now: string | null = null;
    try { now = readFileSync(file, 'utf8'); } catch { now = null; }
    if (now !== text) {
      writeFileSync(file, text, { mode: 0o700 });
      wrote = true;
    }
    chmodSync(file, 0o700);
  }
  if (windows && o.gitExe) {
    const want = readFileSync(o.gitExe);
    const file = guardGit(dir);
    let now: Buffer | null = null;
    try { now = readFileSync(file); } catch { now = null; }
    if (!now || !now.equals(want)) {
      writeFileSync(file, want, { mode: 0o700 });
      wrote = true;
    }
  }
  return wrote;
}

/** scp-style `user@host:` or an ssh host alias's `host:` (no `//` after it: that's a URL's scheme). */
const SCP_PREFIX = /^((?:[^@/:\s]+@)?[^@:/\s]+:)(?!\/\/)/;

/**
 * The URL prefixes every push is rewritten from: the usual schemes, plus each scp-style remote's `user@host:` or `host:`.
 * A remote with a pushurl escapes pushInsteadOf (git's rule): the PATH git refuses every push for that.
 */
export function pushPrefixes(remoteUrls: readonly string[]): string[] {
  const out = ['/', 'file://', 'https://', 'http://', 'ssh://', 'git://', 'git@'];
  for (const u of remoteUrls) {
    const m = SCP_PREFIX.exec(u);
    if (m && !out.some((p) => m[1]!.startsWith(p))) out.push(m[1]!);
  }
  return [...new Set(out)];
}

/** The session's guard environment, in order (the launcher exports each pair). */
export function guardEnv(o: { guardDir: string; branch: string; pushPrefixes: readonly string[]; worktree?: string; project?: string }): [string, string][] {
  if (!validBranchName(o.branch) || /['"\\$`]/.test(o.branch)) throw new Error('invalid run branch');
  const config: [string, string][] = [['core.hooksPath', o.guardDir], ...o.pushPrefixes.map((p): [string, string] => [`url.${NO_PUSH}.pushInsteadOf`, p]),
    // Windows: the run's worktree may hold paths past MAX_PATH.
    ...(currentPlatform() === 'win32' ? [['core.longpaths', 'true'] as [string, string]] : [])];
  return [
    ['GIT_CONFIG_COUNT', String(config.length)],
    ...config.flatMap(([k, v], i): [string, string][] => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]]),
    ['ATELIER_RUN_BRANCH', o.branch],
    // The session's git (bin/git, first on PATH) keeps every command in the run's worktree.
    ...(o.worktree && o.project ? [['ATELIER_RUN_WORKTREE', o.worktree], ['ATELIER_RUN_PROJECT', o.project]] as [string, string][] : [])
  ];
}

/** The folder of the session's git, which the launcher puts first on PATH. */
export const guardBin = (guardDir: string): string => join(guardDir, 'bin');

/** The session's git itself: the script on macOS, git.exe on Windows. */
export const guardGit = (guardDir: string): string => join(guardBin(guardDir), currentPlatform() === 'win32' ? 'git.exe' : 'git');
