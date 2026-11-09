import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { posixRel } from '../support/platform';

// The only files allowed to spawn processes (links.ts no longer does: URLs go through shell.openExternal).
// updates-ipc.ts: codesign (verifying the pending build), ditto (extracting a downloaded update; the in-app updater gets
// only these two through an allowlist) and the helper that swaps the app, fixed-path commands.
// dictation/engine.ts: atelier-whisper (app binary, talks only over pipes); dictation/polish.ts: isolated claude -p.
// daemon/shell-env.ts: the user's own zsh, once per atelierd start or on request, to capture its environment
// (fixed argv, no shell string, stdin /dev/null, timeout); main imports it too (git/user-env.ts), lazily before the
// first git write op and again when a zsh startup file changed.
// procs/exec.ts: /bin/ps and /usr/sbin/lsof for the terminals' listening ports and the work scan,
// and a terminal shell's current folder (Open in Finder), read-only, four fixed argv shapes validated
// before running (pids only), 2 s timeout, 1 MB output cap.
// github/exec.ts: the GitHub CLI for a session branch's PR and CI, read-only, only
// `gh pr view <branch> --json <fixed fields>` (branch validated, no shell), in the repo root, 15 s timeout, 1 MB cap.
// git/fetch.ts: `git fetch` for Source Control, one fixed argv in a listed repo root, no hook, no ext::
// transport, no prompt, no controlling terminal, 60 s timeout on the whole process group, 1 MB cap.
// git/write.ts: the git writes: one argv builder per op from a closed list, validated input (paths
// and messages only on stdin, literal pathspecs), and it runs only invocations those builders made; spawn with an argv,
// detached (no tty), prompts off, editors `:`, writeEnv's environment required, 15/5 min timeouts and Cancel killing
// the whole process group, 1 MB output cap. Hooks run on purpose: they are the user's own checks behind a click.
// shell-command-exec.ts: /usr/bin/osascript for "Install 'atelier' Command" when /usr/local/bin is root-owned:
// only on the user's click, one fixed program, an AppleScript built by adminScript (mkdir + ln of
// the app's own script, or rm of that link; both paths quoted), macOS asks for the administrator password.
// daemon/launchd.ts: /bin/launchctl bootstrap / bootout / list for atelierd's and the terminals' own jobs,
// argv only, labels under dev.useatelier only, 10 s timeout, 4 MB cap.
// scm/message.ts: the isolated `claude -p` that writes ✦ commit messages: no settings, tools, MCP or
// saved session, argv only, the input on stdin, stdout streamed back, its own process group so Stop and a timeout kill
// it whole, 256 KB output cap.
// proc-tree.ts: Windows only, %SystemRoot%\System32\taskkill.exe /PID <pid> /T /F to stop a child Atelier started (git,
// claude -p) with what it started (no process groups there), argv only, 5 s timeout.
// store-exec.ts: Windows only, the app's own atelier-store.exe, `check` or `update`,
// no shell, no window, stdout only, 60 s / 20 min timeout, 64 KB output cap.
// companion/run.ts: the isolated read-only `claude -p` of Ask: argv only from companionArgs,
// Read/Grep/Glob, restricted, dontAsk, question on stdin, stream-json parsed line by line, its own process group so Stop,
// a timeout and quit kill it whole, output capped at 8 MiB per line and 32 MiB per run (stream-json echoes every tool
// result). tests/integration/companion-argv.test.ts: its argv comes from companionArgs only.
// daemon/win-tree.ts: Windows before 11 24H2 only, %SystemRoot%\System32\taskkill.exe /PID <shell> /FI "IMAGENAME eq
// <shell>.exe" /T /F when a terminal closes (closing its console would wait for every program in it, atelierd frozen
// meanwhile), argv only, an integer pid and a plain file name, never awaited, 3 s timeout.
// app-icon-exec.ts: /usr/bin/osascript for the app icon of Docsy's themes: one fixed JavaScript
// program (NSWorkspace.setIcon, then noteFileSystemChanged), argv only (the app's own Docsy image or "", and the
// installed bundle from eligibleBundle: /Applications or ~/Applications, never a build or a temp copy), 10 s timeout,
// 64 KB cap; it writes `Icon\r` and the Finder flag at that bundle's root, outside the code signature's seal.
// databases/ssh-tunnel.ts: the system's ssh for a database connection's SSH tunnel, only
// when the user connects one: `ssh -N -L 127.0.0.1:<free port>:<db>:<port> … -o ControlMaster=no -o ControlPath=none --
// [<user>@]<host>` from sshArgs (the hosts a host name or an IP literal, the user [A-Za-z0-9._-]
// or empty, none starting with '-', refused there and in the schema; never a shared or lingering master), spawn
// with an argv, no shell, BatchMode (never a prompt), stdin/stdout ignored, the last 4 KB of stderr kept; stopped with
// SIGTERM then SIGKILL when its connection closes and on quit.
// context/probe.ts: Context usage's private copy of a session: `claude -p` with
// contextArgs' argv only (stream-json, --resume <id> --fork-session, --no-session-persistence, the user's hooks off),
// no shell, asked only control requests (initialize, mcp_status, get_context_usage: nothing reaches the model), its own
// process group so a timeout (45 s), a stop and quit kill it with the MCP servers it started, 4 MiB per line and 8 MiB
// per run. tests/integration/context-argv.test.ts: its argv comes from contextArgs only.
const ALLOWED = new Set(['src/main/context/probe.ts', 'src/daemon/win-tree.ts', 'src/main/proc-tree.ts', 'src/daemon/launchd.ts', 'src/main/daemon-launcher.ts', 'src/main/git/exec.ts', 'src/main/git/fetch.ts', 'src/main/git/write.ts', 'src/main/tmux/exec.ts', 'src/main/updates-ipc.ts', 'src/main/dictation/engine.ts', 'src/main/dictation/polish.ts', 'src/daemon/shell-env.ts', 'src/main/procs/exec.ts', 'src/main/github/exec.ts', 'src/main/shell-command-exec.ts', 'src/main/scm/message.ts', 'src/main/companion/run.ts', 'src/main/store-exec.ts', 'src/main/app-icon-exec.ts', 'src/main/databases/ssh-tunnel.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });
}

test('child_process only in authorized modules', () => {
  const root = join(__dirname, '..', '..');
  const offenders = walk(join(root, 'src'))
    .filter((f) => /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/.test(readFileSync(f, 'utf8')))
    .map((f) => posixRel(root, f))
    .filter((f) => !ALLOWED.has(f));
  expect(offenders).toEqual([]);
});

// process.execve replaces the running process: only pty-host.js, the terminals' launchd jobs' first image, uses it, to
// become the native PTY host.
test('process.execve only in the pty-host entry', () => {
  const root = join(__dirname, '..', '..');
  const users = walk(join(root, 'src')).filter((f) => /\bprocess\.execve\b/.test(readFileSync(f, 'utf8'))).map((f) => posixRel(root, f));
  expect(users).toEqual(['src/daemon/pty-host-main.ts']);
});
