import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { expect, test } from 'vitest';
import { ATELIER_BASH, gitBashArgs } from '../../src/daemon/install-files';
import { osc7Path } from '../../src/main/osc7';
import { toCanonical } from '../../src/shared/paths';
import { isWin } from '../support/platform';

// Atelier's Git Bash integration in a real bash: Git Bash on Windows, /bin/bash (3.2) on macOS, which runs the same
// file. The user's login files, the prompt signal atelierd reads, the folder for the app (OSC 7), Atelier's bin first
// on PATH. A temporary HOME holds the "user's" files: never the developer's own.

const GIT_BASH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const BASH = isWin ? GIT_BASH : '/bin/bash';
const canRun = !isWin || existsSync(GIT_BASH);
const NONCE = '0123456789abcdef0123456789abcdef';

interface Run { home?: Record<string, string>; dirs?: string[]; env?: Record<string, string>; lines: string[] }

/** A folder as bash sees it: /c/… for C:\… on Windows (cygpath -u), as is elsewhere. */
function bashPath(p: string): string {
  if (!isWin) return p;
  const s = p.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(s) ? `/${s[0]!.toLowerCase()}${s.slice(2)}` : s;
}

/** A fake claude: prints its arguments (printf: macOS's /bin/sh echo would read backslashes in a Windows path). */
const FAKE_CLAUDE = '#!/bin/sh\nprintf \'%s\\n\' "ARGS:$*"\n';
/** In a profile: the fake claude first on PATH. */
const FAKE_FIRST = 'PATH="$HOME/fakebin:$PATH"\n';

/** PATH without any folder holding a real claude: whatever a test gets wrong, it never starts Claude Code. */
function pathWithoutClaude(): string[] {
  const sep = isWin ? ';' : ':';
  return (process.env.PATH ?? process.env.Path ?? '').split(sep)
    .filter((d) => d && !['claude', 'claude.exe', 'claude.cmd'].some((n) => existsSync(join(d, n))));
}

async function runBash(o: Run): Promise<{ out: string; home: string; atelierHome: string; settings: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'atl-gb-'));
  const rc = join(dir, 'atelier.bash');
  writeFileSync(rc, ATELIER_BASH);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'fakebin'), { recursive: true });
  writeFileSync(join(home, 'fakebin', 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  for (const [name, text] of Object.entries(o.home ?? {})) writeFileSync(join(home, name), text);
  for (const d of o.dirs ?? []) mkdirSync(join(home, d), { recursive: true });
  const atelierHome = join(dir, 'atelier home');
  mkdirSync(join(atelierHome, 'bin'), { recursive: true });
  const settings = join(atelierHome, 'claude-settings.json');
  writeFileSync(settings, '{}');
  const sep = isWin ? ';' : ':';
  // Only what a terminal of atelierd's gets, never this process's own ATELIER_* (it may run inside Atelier).
  const env: Record<string, string> = {
    PATH: [join(atelierHome, 'bin'), ...pathWithoutClaude()].join(sep),
    HOME: home, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', BASH_SILENCE_DEPRECATION_WARNING: '1',
    ATELIER_HOME: atelierHome, ATELIER_SOCK: isWin ? '\\\\.\\pipe\\atelier-test' : join(dir, 'atelierd.sock'),
    ATELIER_CLAUDE_SETTINGS: settings,
    ...(isWin ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', ProgramFiles: process.env.ProgramFiles ?? 'C:\\Program Files' } : {}),
    ...o.env
  };
  return new Promise((resolve, reject) => {
    const p = pty.spawn(BASH, gitBashArgs(rc), { name: 'xterm-256color', cols: 200, rows: 40, cwd: dir, env });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; output so far: ${JSON.stringify(out)}`)); }, 30_000);
    p.onData((d) => { out += d; });
    p.onExit(() => { clearTimeout(timer); resolve({ out, home, atelierHome, settings }); });
    for (const l of [...o.lines, 'exit']) p.write(l + '\r');
  });
}

const signals = (out: string, nonce: string) => out.split(`\x1b]133;P;atelier=${nonce}\x07`).length - 1;
const osc7s = (out: string) => [...out.matchAll(/\x1b\]7;([^\x07]*)\x07/g)].map((m) => m[1]!);

test.runIf(canRun)('the user’s login files load, as bash -l would', async () => {
  const a = await runBash({ home: { '.bash_profile': "export ATL_P=loaded\nalias ll='ls -l'\n" }, lines: ['echo "P=$ATL_P"', 'alias ll'] });
  expect(a.out).toContain('P=loaded');
  expect(a.out).toContain("alias ll='ls -l'");
  const b = await runBash({ home: { '.profile': 'export ATL_P=profile\n' }, lines: ['echo "P=$ATL_P"'] });
  expect(b.out).toContain('P=profile');
}, 60_000);

test.runIf(canRun)('the prompt signal carries the nonce, which no program sees', async () => {
  const a = await runBash({ env: { ATELIER_PROMPT_NONCE: NONCE }, lines: ['echo "N=${ATELIER_PROMPT_NONCE:-none}"'] });
  expect(signals(a.out, NONCE)).toBeGreaterThanOrEqual(2);
  expect(a.out).toContain('N=none');
  const b = await runBash({ env: { ATELIER_PROMPT_NONCE: 'xyz!' }, lines: ['true'] });
  expect(b.out).not.toContain('\x1b]133;P');
}, 60_000);

test.runIf(canRun)('OSC 7 names the folder, percent-encoded', async () => {
  const name = 'a b#%é?';
  const r = await runBash({ dirs: [name], lines: [`cd "$HOME/${name}"`] });
  const last = osc7s(r.out).at(-1)!;
  expect(last).not.toMatch(/[ #?é]/);
  const want = isWin ? toCanonical(join(r.home, name), 'win32') : join(r.home, name);
  expect(osc7Path(last, isWin ? 'win32' : 'posix')).toBe(want);
}, 60_000);

test.runIf(canRun)('Atelier’s bin comes first, also if the user’s files moved it, and only once', async () => {
  const r = await runBash({ home: { '.bash_profile': 'PATH="/usr/bin:$PATH"\n' }, lines: ['echo "H=${PATH%%:*}"', 'echo "PATH=:$PATH:"'] });
  const bin = `${bashPath(r.atelierHome)}/bin`;
  expect(r.out).toContain(`H=${bin}`);
  const path = /PATH=(:[^\r\n]*:)\r?\n/.exec(r.out.slice(r.out.lastIndexOf('PATH=:')))![1]!;
  expect(path.split(`:${bin}:`).length - 1).toBe(1);
}, 60_000);

test.runIf(canRun)('a prompt command of the user’s still runs, after ours, with the command’s $?', async () => {
  const r = await runBash({
    env: { ATELIER_PROMPT_NONCE: NONCE },
    home: { '.bash_profile': `PROMPT_COMMAND='echo "UPC=$?"'\n` },
    lines: ['false', 'true']
  });
  expect(r.out).toMatch(/UPC=1[\s\S]*UPC=0/);
  expect(r.out.indexOf(`133;P;atelier=${NONCE}`)).toBeLessThan(r.out.indexOf('UPC='));
  const ps1 = await runBash({ home: { '.bash_profile': "PS1='[$?] '\n" }, lines: ['false'] });
  expect(ps1.out).toContain('[1] ');
}, 60_000);

test.runIf(isWin && existsSync(GIT_BASH))('an array PROMPT_COMMAND (bash 5.1+) keeps its elements, ours first', async () => {
  const r = await runBash({ env: { ATELIER_PROMPT_NONCE: NONCE }, home: { '.bash_profile': "PROMPT_COMMAND=('echo A1' 'echo A2')\n" }, lines: ['true'] });
  expect(r.out).toMatch(new RegExp(`133;P;atelier=${NONCE}\\x07[\\s\\S]*A1[\\s\\S]*A2`));
}, 60_000);

test.runIf(canRun)('claude gets Atelier’s settings; subcommands and --print run plain', async () => {
  const r = await runBash({ home: { '.bash_profile': FAKE_FIRST }, lines: ['claude --name=x', 'claude mcp list', 'claude -p hi', 'claude --print=x'] });
  expect(r.out).toContain(`ARGS:--settings ${r.settings} --name=x`);
  expect(r.out).toContain('ARGS:mcp list\r');
  expect(r.out).toContain('ARGS:-p hi\r');
  expect(r.out).toContain('ARGS:--print=x\r');
}, 60_000);

test.runIf(canRun)('outside an Atelier terminal (no atelierd socket) claude runs plain', async () => {
  const r = await runBash({ env: { ATELIER_SOCK: '' }, home: { '.bash_profile': FAKE_FIRST }, lines: ['claude --name=x'] });
  expect(r.out).toContain('ARGS:--name=x\r');
}, 60_000);

test.runIf(canRun)('an alias cc=claude goes through Atelier’s claude', async () => {
  const r = await runBash({ home: { '.bash_profile': FAKE_FIRST + 'alias cc=claude\n' }, lines: ['cc a'] });
  expect(r.out).toContain(`ARGS:--settings ${r.settings} a`);
}, 60_000);

test.runIf(canRun)('the user’s own claude alias and function stay, without calling themselves again', async () => {
  const a = await runBash({ home: { '.bash_profile': FAKE_FIRST + "alias claude='claude --model m'\n" }, lines: ['claude a'] });
  expect(a.out).toContain(`ARGS:--model m --settings ${a.settings} a`);
  const f = await runBash({ home: { '.bash_profile': FAKE_FIRST + 'claude() { command claude --from-fn "$@"; }\n' }, lines: ['claude a'] });
  expect(f.out).toContain(`ARGS:--from-fn --settings ${f.settings} a`);
}, 60_000);

test.runIf(canRun)('ATELIER_CLAUDE_BIN wins; in the e2e suite a real claude is refused', async () => {
  const blocked = await runBash({ env: { ATELIER_E2E: '1' }, lines: ['claude a', 'echo "rc=$?"'] });
  expect(blocked.out).toContain('REAL-CLAUDE-BLOCKED');
  expect(blocked.out).toContain('rc=97');
  const dir = mkdtempSync(join(tmpdir(), 'atl-gb-bin-'));
  const bin = join(dir, 'fake-claude');
  writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "BIN:$*"\n', { mode: 0o755 });
  const r = await runBash({ env: { ATELIER_E2E: '1', ATELIER_CLAUDE_BIN: bin }, home: { '.bash_profile': FAKE_FIRST }, lines: ['claude a'] });
  expect(r.out).toContain(`BIN:--settings ${r.settings} a`);
}, 60_000);

test.runIf(canRun)('set -u in the user’s profile breaks nothing', async () => {
  const r = await runBash({ env: { ATELIER_PROMPT_NONCE: NONCE }, home: { '.bash_profile': FAKE_FIRST + 'set -u\n' }, lines: ['claude a', 'cd ..', 'true'] });
  expect(r.out).not.toContain('unbound variable');
  expect(r.out).toContain(`ARGS:--settings ${r.settings} a`);
}, 60_000);

test.runIf(isWin && existsSync(GIT_BASH))('no claude on PATH: the one Claude’s native installer puts in ~/.local/bin', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'atl-gb-up-'));
  mkdirSync(join(profile, '.local', 'bin'), { recursive: true });
  // Any program that prints its arguments stands in for claude.exe.
  copyFileSync(join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'echo.exe'), join(profile, '.local', 'bin', 'claude.exe'));
  const r = await runBash({ env: { USERPROFILE: profile }, lines: ['claude a'] });
  expect(r.out).toContain(`--settings ${r.settings} a`);
}, 60_000);
