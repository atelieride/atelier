import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { runDaemon, type RunningDaemon } from '../../src/daemon/main';
import type { ServerMessage, TerminalInfo } from '../../src/shared/protocol';
import { isWin, useMachinePlatform } from '../support/platform';
import { connectControl } from './helpers';

// atelierd on Windows end to end: a PowerShell terminal with Atelier's integration, the
// `claude` function adding Atelier's settings, the native bridge carrying hooks over the named pipe, the session in the
// terminal list with canonical paths, and the status-line bridge running the user's own status line. Needs the bridge
// built (`node scripts/build-bridge.mjs`, part of `npm run build` on Windows).

useMachinePlatform();
const BRIDGE = resolve('vendor', 'bin', 'atelier-bridge.exe');
const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const running: RunningDaemon[] = [];
afterEach(async () => { for (const d of running.splice(0)) await d.stop(); });

async function start(statusLine?: string) {
  const home = mkdtempSync(join(tmpdir(), 'atl-win-'));
  const user = join(home, 'user-settings.json');
  writeFileSync(user, JSON.stringify(statusLine ? { statusLine: { type: 'command', command: statusLine } } : {}));
  // A fake claude: sends a SessionStart through the bridge Atelier's settings name, as Claude Code would.
  const fake = join(home, 'claude.cmd');
  const argv = join(home, 'argv.txt');
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID, cwd: 'C:\\atl\\proj', source: 'startup' });
  // It stays a while, as a real Claude does: when it ends, the shell's own prompt mark ends the session.
  writeFileSync(fake, `@echo %*> "${argv}"\r\n@echo ${payload}| "%ATELIER_HOME%\\bin\\atelier-bridge.exe" hook\r\n@ping -n 30 127.0.0.1 >nul\r\n`);
  const d = await runDaemon({ home, version: '0.0.0-test', bridges: [BRIDGE], userClaudeSettings: user, extraEnv: { ATELIER_CLAUDE_BIN: fake } });
  running.push(d);
  return { d, home, argv };
}

test.runIf(isWin)('a session started in an Atelier terminal reaches atelierd through the bridge', async () => {
  expect(existsSync(BRIDGE)).toBe(true);
  const { d, argv } = await start();
  const settings = JSON.parse(readFileSync(d.paths.settings, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toMatch(/atelier-bridge\.exe hook$/);
  const c = await connectControl(d.paths.sock, d.info.token);
  await c.next((m) => m.t === 'welcome');
  const cwd = tmpdir().replace(/\\/g, '/');
  c.send({ t: 'create', rid: 1, projectRoot: cwd, cwd, cols: 120, rows: 30, profile: 'atelier', command: 'claude --name=demo' });
  const created = await c.next((m) => m.t === 'reply' && m.rid === 1, 20_000) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
  const id = (created.result as TerminalInfo).id;
  const withSession = await c.next((m) => m.t === 'terminals' && m.list.some((t) => t.id === id && t.session?.sessionId === SID), 30_000) as Extract<ServerMessage, { t: 'terminals' }>;
  const t = withSession.list.find((x) => x.id === id)!;
  expect(t.session?.cwd).toBe('C:/atl/proj');
  expect(t.cwd).toMatch(/^[A-Z]:\//);
  expect(t.profile).toBe('atelier');
  expect(readFileSync(argv, 'utf8').trim()).toMatch(/^--settings .*claude-settings\.json --name=demo$/);
  c.close();
}, 60_000);

test.runIf(isWin)('the status-line bridge forwards the data and prints the user’s own status line', async () => {
  const { d, home } = await start('echo STATUS-OK');
  expect(readFileSync(d.paths.userStatusline, 'utf8')).toBe('echo STATUS-OK\n');
  const env = { ...process.env, ATELIER_HOME: home, ATELIER_SOCK: d.paths.sock, ATELIER_HOOK_TOKEN: d.hookToken, ATELIER_TERMINAL_ID: '0a1b2c3d-0000-0000-0000-000000000000' };
  const out = execFileSync(join(d.paths.bin, 'atelier-bridge.exe'), ['status'], { input: '{"model":{"display_name":"x"}}', env, encoding: 'utf8', timeout: 20_000 });
  expect(out.trim()).toBe('STATUS-OK');
}, 60_000);

const GIT_BASH = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const GIT_CMD = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd');
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// A user folder with a space (C:\Users\Mario Rossi): Claude's settings call the bridge by name, and whichever shell
// Claude runs hooks with (Git Bash, or PowerShell without it) finds it on the PATH atelier.ps1 sets.
for (const shell of ['Git Bash', 'PowerShell'] as const) {
  test.runIf(isWin && (shell === 'PowerShell' || existsSync(GIT_BASH)))(`a home with a space: the hook reaches atelierd through ${shell}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'atl win '));
    const user = join(home, 'user-settings.json');
    writeFileSync(user, '{}');
    const fake = join(home, 'claude.cmd');
    const d = await runDaemon({ home, version: '0.0.0-test', bridges: [BRIDGE], userClaudeSettings: user, extraEnv: { ATELIER_CLAUDE_BIN: fake } });
    running.push(d);
    const settings = JSON.parse(readFileSync(d.paths.settings, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const command = settings.hooks.SessionStart![0]!.hooks[0]!.command;
    expect(command).toBe('atelier-bridge hook');
    const payload = join(home, 'payload.json');
    writeFileSync(payload, JSON.stringify({ hook_event_name: 'SessionStart', session_id: SID, cwd: 'C:\\atl\\proj', source: 'startup' }));
    // A fake claude running the hook command as Claude Code does, the event on the shell's stdin.
    const run = shell === 'Git Bash' ? `"${GIT_BASH}" -c "${command}"` : `"${POWERSHELL}" -NoProfile -NonInteractive -Command "${command}"`;
    writeFileSync(fake, `@${run} < "${payload}"\r\n@ping -n 30 127.0.0.1 >nul\r\n`);
    const c = await connectControl(d.paths.sock, d.info.token);
    await c.next((m) => m.t === 'welcome');
    const cwd = tmpdir().replace(/\\/g, '/');
    c.send({ t: 'create', rid: 1, projectRoot: cwd, cwd, cols: 120, rows: 30, profile: 'atelier', command: 'claude' });
    const created = await c.next((m) => m.t === 'reply' && m.rid === 1, 20_000) as Extract<ServerMessage, { t: 'reply'; ok: true }>;
    const id = (created.result as TerminalInfo).id;
    await c.next((m) => m.t === 'terminals' && m.list.some((t) => t.id === id && t.session?.sessionId === SID), 30_000);
    c.close();
  }, 60_000);
}

test.runIf(isWin && existsSync(GIT_CMD))('the user’s status line runs in the Git Bash next to the git on PATH (a per-user install)', async () => {
  const { d, home } = await start('echo "BASH:$BASH_VERSION"');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(path|programfiles|programw6432|localappdata|claude_code_git_bash_path)$/i.test(k)) env[k] = v;
  // Git nowhere the old bridge looked (Program Files), only on PATH, as a per-user install leaves it. A 64-bit process
  // gets ProgramFiles from ProgramW6432, whatever its parent passed.
  Object.assign(env, {
    Path: `${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')};${GIT_CMD}`, ProgramFiles: 'C:\\atl-nowhere', ProgramW6432: 'C:\\atl-nowhere', LOCALAPPDATA: 'C:\\atl-nowhere',
    ATELIER_HOME: home, ATELIER_SOCK: d.paths.sock, ATELIER_HOOK_TOKEN: d.hookToken, ATELIER_TERMINAL_ID: '0a1b2c3d-0000-0000-0000-000000000000'
  });
  const out = execFileSync(join(d.paths.bin, 'atelier-bridge.exe'), ['status'], { input: '{"model":{"display_name":"x"}}', env, encoding: 'utf8', timeout: 20_000 });
  expect(out.trim()).toMatch(/^BASH:\d/);
}, 60_000);

test.runIf(isWin)('the bridge never takes a Git Bash from a relative PATH entry (one that resolves inside the project)', async () => {
  const { d, home } = await start('echo "BASH:$BASH_VERSION"');
  // A planted git.exe and bin\bash.exe under the project (copies of the bridge: they print nothing), reached through a
  // relative PATH entry; no other Git anywhere.
  const project = mkdtempSync(join(tmpdir(), 'atl-proj-'));
  mkdirSync(join(project, 'tools', 'git', 'cmd'), { recursive: true });
  mkdirSync(join(project, 'tools', 'git', 'bin'), { recursive: true });
  copyFileSync(BRIDGE, join(project, 'tools', 'git', 'cmd', 'git.exe'));
  copyFileSync(BRIDGE, join(project, 'tools', 'git', 'bin', 'bash.exe'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(path|programfiles|programw6432|localappdata|claude_code_git_bash_path)$/i.test(k)) env[k] = v;
  Object.assign(env, {
    Path: `${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')};tools\\git\\cmd`, ProgramFiles: 'C:\\atl-nowhere', ProgramW6432: 'C:\\atl-nowhere', LOCALAPPDATA: 'C:\\atl-nowhere',
    ATELIER_HOME: home, ATELIER_SOCK: d.paths.sock, ATELIER_HOOK_TOKEN: d.hookToken, ATELIER_TERMINAL_ID: '0a1b2c3d-0000-0000-0000-000000000000'
  });
  const out = execFileSync(join(d.paths.bin, 'atelier-bridge.exe'), ['status'], { input: '{"model":{"display_name":"x"}}', env, cwd: project, encoding: 'utf8', timeout: 20_000 });
  // PowerShell ran it (no Git Bash to be found), not the planted bash.
  expect(out.trim()).toBe('BASH:');
}, 60_000);

test.runIf(isWin)('outside an Atelier terminal the bridge does nothing and exits 0', () => {
  const env = { ...process.env, ATELIER_SOCK: '', ATELIER_HOOK_TOKEN: '', ATELIER_TERMINAL_ID: '' };
  expect(execFileSync(BRIDGE, ['hook'], { input: '{}', env, encoding: 'utf8', timeout: 10_000 })).toBe('');
});
