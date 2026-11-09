import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';

const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); }
};

function fakeClaude(dir: string): string {
  const f = join(dir, 'finto-claude');
  writeFileSync(f, '#!/bin/sh\necho "ARGS:$*"\n');
  chmodSync(f, 0o755);
  return f;
}

interface Opts { userZdotdir?: string | null; extraEnv?: Record<string, string> }
async function start(o: Opts) {
  const home = mkdtempSync(join(tmpdir(), 'atl-z-'));
  const d = await runDaemon({
    home, version: 't', shellArgs: ['-l'], userClaudeSettings: join(home, 'nessuna.json'),
    userZdotdir: o.userZdotdir, extraEnv: o.extraEnv
  });
  running.push(d);
  return d;
}

/** A user configuration in a fake ZDOTDIR folder. */
function userConfig(files: Record<string, string>): string {
  const z = mkdtempSync(join(tmpdir(), 'atl-uz-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(z, n), c);
  return z;
}

function run(d: RunningDaemon, cmd: string) {
  const info = d.terminals.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 200, rows: 40 });
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  d.terminals.input(info.id, cmd + '\r');
  return { get out() { return out; } };
}

test('loads the user configuration and then gives ZDOTDIR back to them', async () => {
  const userZ = userConfig({ '.zshrc': 'export ATL_USER_RC=caricato\nPS1="$ "\n', '.zshenv': 'export ATL_USER_ENV=caricato\n' });
  const d = await start({ userZdotdir: userZ });
  const r = run(d, 'echo "R=$ATL_USER_RC E=$ATL_USER_ENV Z=$ZDOTDIR"');
  await until(() => r.out.includes(`R=caricato E=caricato Z=${userZ}`));
});

test('history stays the user\'s (HISTFILE from /etc/zshrc), not an Atelier file', async () => {
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  const d = await start({ userZdotdir: userZ });
  const r = run(d, 'echo "H=$HISTFILE"');
  await until(() => r.out.includes(`H=${userZ}/.zsh_history`));
});

test('XDG ZDOTDIR set in the user\'s .zshenv: their configuration is loaded', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'atl-home-'));
  mkdirSync(join(fakeHome, '.config', 'zsh'), { recursive: true });
  writeFileSync(join(fakeHome, '.zshenv'), 'export ZDOTDIR="${ZDOTDIR:-$HOME/.config/zsh}"\n');
  writeFileSync(join(fakeHome, '.config', 'zsh', '.zshrc'), 'export ATL_XDG=si\nPS1="$ "\n');
  const d = await start({ userZdotdir: null, extraEnv: { HOME: fakeHome } });
  const r = run(d, 'echo "X=$ATL_XDG Z=$ZDOTDIR"');
  await until(() => r.out.includes(`X=si Z=${fakeHome}/.config/zsh`));
});

test('user without ZDOTDIR: in the end ZDOTDIR is unset, as in a normal shell', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'atl-home-'));
  writeFileSync(join(fakeHome, '.zshrc'), 'PS1="$ "\n');
  const d = await start({ userZdotdir: null, extraEnv: { HOME: fakeHome } });
  const r = run(d, 'echo "Z=${ZDOTDIR-nessuno}"');
  await until(() => r.out.includes('Z=nessuno'));
});

test('claude goes through the Atelier function with --settings', async () => {
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_CLAUDE_BIN: fakeClaude(userZ) } });
  const r = run(d, 'claude --model haiku');
  await until(() => /ARGS:--settings \S.*claude-settings\.json --model haiku/.test(r.out));
});

// Claude accounts: another account starts as `CLAUDE_CONFIG_DIR='<dir>' claude …`, which must still go
// through the function (an `env CLAUDE_CONFIG_DIR=…` would skip it, and with it the hooks).
function fakeClaudeWithDir(dir: string): string {
  const f = join(dir, 'finto-claude-dir');
  writeFileSync(f, '#!/bin/sh\necho "DIR:${CLAUDE_CONFIG_DIR-none} ARGS:$*"\n');
  chmodSync(f, 0o755);
  return f;
}

test('an account\'s initial command reaches Claude with its CLAUDE_CONFIG_DIR and the hooks', async () => {
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  // The shell's own CLAUDE_CONFIG_DIR is fixed here: tests may run inside a Claude session that exports another one.
  const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_CLAUDE_BIN: fakeClaudeWithDir(userZ), CLAUDE_CONFIG_DIR: '/tmp/inherited' } });
  const info = d.terminals.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 200, rows: 40, command: `CLAUDE_CONFIG_DIR='/tmp/a b/.claude_ops' claude --name='x'` });
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  await until(() => /DIR:\/tmp\/a b\/\.claude_ops ARGS:--settings \S.*claude-settings\.json --name=x/.test(out));
  // The assignment lasts for that command only: the shell keeps its own.
  d.terminals.input(info.id, 'claude --x\r');
  await until(() => /DIR:\/tmp\/inherited ARGS:--settings \S.*claude-settings\.json --x/.test(out));
});

test('claude -p does not add the hooks', async () => {
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_CLAUDE_BIN: fakeClaude(userZ) } });
  const r = run(d, 'claude -p ciao');
  await until(() => r.out.includes('ARGS:-p ciao'));
});

// Claude Code refuses `--settings` before `remote-control` (its sessions wouldn't get it), and no subcommand starts a
// session of its own that the hooks could follow: they all go through untouched.
test('claude subcommands (rc, remote-control, mcp…) do not add the hooks', async () => {
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_CLAUDE_BIN: fakeClaude(userZ) } });
  const r = run(d, 'claude rc --help; claude remote-control; claude mcp list; claude update');
  await until(() => ['rc --help', 'remote-control', 'mcp list', 'update'].every((a) => r.out.includes(`ARGS:${a}\r`)));
  // A prompt that only starts with a subcommand's name is still a session.
  const p = run(d, 'claude "update the readme"');
  await until(() => /ARGS:--settings \S.*claude-settings\.json update the readme/.test(p.out));
});

test('claude alias to a path: the hooks are still there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-al-'));
  const userZ = userConfig({ '.zshrc': `PS1="$ "\nalias claude=${fakeClaude(dir)}\n` });
  const d = await start({ userZdotdir: userZ });
  const r = run(d, 'claude -n prova');
  await until(() => /ARGS:--settings \S.*claude-settings\.json -n prova/.test(r.out));
});

test('user claude function: it is respected and receives the hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-fn-'));
  const userZ = userConfig({ '.zshrc': `PS1="$ "\nclaude() { echo UTENTE; ${fakeClaude(dir)} "$@"; }\n` });
  const d = await start({ userZdotdir: userZ });
  const r = run(d, 'claude x');
  await until(() => r.out.includes('UTENTE') && /ARGS:--settings \S.*claude-settings\.json x/.test(r.out));
});

test('initial command (New session, Resume) even if the configuration asks a question at startup', async () => {
  // Like the oh-my-zsh update: it reads a key while the .zshrc is loading.
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\nprint -n "Would you like to update? [Y/n] "; read -k1 risposta; print\n' });
  const d = await start({ userZdotdir: userZ });
  const info = d.terminals.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 200, rows: 40, command: 'echo AVVIATO-$((1+1))' });
  let out = '';
  d.terminals.attach(info.id, () => {}, (x) => { out += x; });
  await until(() => out.includes('Would you like to update?'));
  await new Promise((r) => setTimeout(r, 600));
  d.terminals.input(info.id, 'n'); // the answer comes from the user, not from Atelier's command
  await until(() => out.includes('AVVIATO-2'));
  expect(out).not.toContain('command not found');
});

// e2e sets ATELIER_E2E: whatever the PATH order (path_helper in /etc/zprofile can move system folders first), the
// claude function refuses anything but the fake ATELIER_CLAUDE_BIN. Every "real" claude here is a fake that prints
// USER-CLAUDE-RAN: a user function, a user alias, or the first claude on PATH (Atelier profile).
test('ATELIER_E2E: claude refuses anything but ATELIER_CLAUDE_BIN, in both zsh profiles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-e2eg-'));
  const userBin = join(dir, 'user-claude');
  writeFileSync(userBin, '#!/bin/sh\necho USER-CLAUDE-RAN\n');
  chmodSync(userBin, 0o755);
  const fakeBinDir = join(dir, 'bin');
  mkdirSync(fakeBinDir);
  writeFileSync(join(fakeBinDir, 'claude'), '#!/bin/sh\necho USER-CLAUDE-RAN\n');
  chmodSync(join(fakeBinDir, 'claude'), 0o755);
  const PATH = `${fakeBinDir}:/usr/bin:/bin`;
  const cases: { rc: string; profile: 'user' | 'atelier' }[] = [
    { rc: `PS1="$ "\nclaude() { ${userBin} "$@"; }\n`, profile: 'user' },
    { rc: `PS1="$ "\nalias claude=${userBin}\n`, profile: 'user' },
    { rc: 'PS1="$ "\n', profile: 'atelier' }
  ];
  for (const c of cases) {
    const userZ = userConfig({ '.zshrc': c.rc });
    const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_E2E: '1', PATH } });
    const info = d.terminals.create({ projectRoot: tmpdir(), cwd: tmpdir(), cols: 200, rows: 40, profile: c.profile });
    let out = '';
    d.terminals.attach(info.id, () => {}, (x) => { out += x; });
    d.terminals.input(info.id, 'claude --version; echo "rc=$?"\r');
    await until(() => /rc=\d/.test(out)).catch(() => {});
    expect(out, `${c.profile} ${c.rc}`).toContain('REAL-CLAUDE-BLOCKED');
    expect(out).toContain('rc=97');
    expect(out).not.toContain('USER-CLAUDE-RAN');
  }
  // The fake one still runs.
  const userZ = userConfig({ '.zshrc': 'PS1="$ "\n' });
  const d = await start({ userZdotdir: userZ, extraEnv: { ATELIER_E2E: '1', ATELIER_CLAUDE_BIN: fakeClaude(userZ), PATH } });
  const r = run(d, 'claude -n x');
  await until(() => /ARGS:--settings \S.*claude-settings\.json -n x/.test(r.out));
});
