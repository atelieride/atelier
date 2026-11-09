import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { daemonPaths } from '@shared/paths.node';
import { writeFileAtomic } from './fsutil';
import { HOOK_EVENTS, buildClaudeSettings, installAtelierFiles, installPtyHost, readUserStatusLine } from './install';

const tmp = () => mkdtempSync(join(tmpdir(), 'atl-i-'));

test('user status line: command, interval and padding', () => {
  const f = join(tmp(), 's.json');
  writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/s.sh', refreshInterval: 30, padding: 0 } }));
  expect(readUserStatusLine(f)).toEqual({ command: 'bash ~/.claude/s.sh', refreshInterval: 30, padding: 0 });
});
test('status line missing, not a command, or broken file → null', () => {
  const d = tmp();
  writeFileSync(join(d, 'a.json'), '{}');
  writeFileSync(join(d, 'b.json'), JSON.stringify({ statusLine: { type: 'static', text: 'x' } }));
  writeFileSync(join(d, 'c.json'), '{nope');
  expect(readUserStatusLine(join(d, 'a.json'))).toBeNull();
  expect(readUserStatusLine(join(d, 'b.json'))).toBeNull();
  expect(readUserStatusLine(join(d, 'c.json'))).toBeNull();
  expect(readUserStatusLine(join(d, 'missing.json'))).toBeNull();
});
test('Claude settings: all hooks point to the bridge, status line carries the user options', () => {
  const s = buildClaudeSettings('/A S/bin', { command: 'x', refreshInterval: 30 }) as {
    hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>;
    statusLine: Record<string, unknown>;
  };
  expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  for (const ev of HOOK_EVENTS) {
    expect(s.hooks[ev]).toEqual([{ hooks: [{ type: 'command', command: "'/A S/bin/atelier-hook'", timeout: 2 }] }]);
  }
  expect(s.statusLine).toEqual({ type: 'command', command: "'/A S/bin/atelier-statusline'", refreshInterval: 30 });
});
test('v2.0: the richer-state events go through the same bridge (subagents, compaction)', () => {
  const s = buildClaudeSettings('/b', null) as { hooks: Record<string, unknown> };
  for (const ev of ['SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'Notification', 'StopFailure', 'UserPromptSubmit']) {
    expect(s.hooks[ev]).toEqual([{ hooks: [{ type: 'command', command: "'/b/atelier-hook'", timeout: 2 }] }]);
  }
});
test('exact attribution: PostToolUseFailure goes through the same bridge', () => {
  const s = buildClaudeSettings('/b', null) as { hooks: Record<string, unknown> };
  expect(s.hooks.PostToolUseFailure).toEqual([{ hooks: [{ type: 'command', command: "'/b/atelier-hook'", timeout: 2 }] }]);
});
test('without a user status line ours stays, with no extra options', () => {
  const s = buildClaudeSettings('/b', null) as { statusLine: Record<string, unknown> };
  expect(s.statusLine).toEqual({ type: 'command', command: "'/b/atelier-statusline'" });
});
test('install: files, permissions and contents', () => {
  const home = tmp();
  const user = join(tmp(), 'settings.json');
  writeFileSync(user, JSON.stringify({ statusLine: { type: 'command', command: 'echo hello' } }));
  const p = daemonPaths(home);
  installAtelierFiles(p, user);
  for (const f of ['atelier-hook', 'atelier-statusline']) expect(statSync(join(p.bin, f)).mode & 0o777).toBe(0o755);
  for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'atelier.zsh']) expect(statSync(join(p.shell, 'zsh', f)).mode & 0o777).toBe(0o644);
  expect(readFileSync(p.userStatusline, 'utf8')).toBe('echo hello\n');
  expect(JSON.parse(readFileSync(p.settings, 'utf8')).hooks.Stop).toBeDefined();
  expect(statSync(p.bin).mode & 0o777).toBe(0o700);
});
test('install without a user status line → empty file', () => {
  const home = tmp();
  const p = daemonPaths(home);
  installAtelierFiles(p, join(home, 'does-not-exist.json'));
  expect(readFileSync(p.userStatusline, 'utf8')).toBe('');
});

test('ATELIER_USER_CLAUDE_SETTINGS replaces ~/.claude/settings.json as the status line source (tests and e2e)', () => {
  const d = tmp();
  const f = join(d, 'fake.json');
  writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: 'echo FAKE' } }));
  const saved = process.env.ATELIER_USER_CLAUDE_SETTINGS;
  process.env.ATELIER_USER_CLAUDE_SETTINGS = f;
  try {
    expect(readUserStatusLine()).toEqual({ command: 'echo FAKE' });
  } finally {
    if (saved === undefined) delete process.env.ATELIER_USER_CLAUDE_SETTINGS; else process.env.ATELIER_USER_CLAUDE_SETTINGS = saved;
  }
});

test('install: the Atelier profile has its own zsh folder and a private history file', () => {
  const p = daemonPaths(tmp());
  installAtelierFiles(p, join(p.home, 'none.json'));
  for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'atelier.zsh']) expect(statSync(join(p.shell, 'atelier', f)).mode & 0o777).toBe(0o644);
  expect(statSync(join(p.shell, 'atelier')).mode & 0o777).toBe(0o700);
  // The initial command and the claude function are the same code in both profiles.
  expect(readFileSync(join(p.shell, 'atelier', 'atelier.zsh'), 'utf8')).toBe(readFileSync(join(p.shell, 'zsh', 'atelier.zsh'), 'utf8'));
  // The user's files are never read by the Atelier profile.
  for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) expect(readFileSync(join(p.shell, 'atelier', f), 'utf8')).not.toMatch(/ATELIER_USER_ZDOTDIR:-\$HOME|source "\$\{ZDOTDIR:-\$HOME\}/);
  expect(statSync(join(p.shell, 'history')).mode & 0o777).toBe(0o600);
});
test('install keeps an existing history and makes it private again', () => {
  const p = daemonPaths(tmp());
  installAtelierFiles(p, join(p.home, 'none.json'));
  const h = join(p.shell, 'history');
  writeFileSync(h, ': 1:0;ls\n', { mode: 0o644 });
  installAtelierFiles(p, join(p.home, 'none.json'));
  expect(readFileSync(h, 'utf8')).toBe(': 1:0;ls\n');
  expect(statSync(h).mode & 0o777).toBe(0o600);
});

// Session coalitions R7: atelierd runs its own copies of the terminal host files, so an app update (new bundle) never
// changes what a running atelierd launches.
test('installPtyHost copies pty-host.js and the native host into bin/ and points the isolation at the copies', () => {
  const d = tmp();
  const paths = daemonPaths(join(d, 'home'));
  const src = join(d, 'bundle');
  writeFileSync(join(d, 'pty-host.js'), 'console.log(1)\n');
  mkdirSync(src);
  writeFileSync(join(src, 'atelier-pty-host'), 'MACHO');
  const iso = installPtyHost(paths, { execPath: '/A/Atelier', hostScript: join(d, 'pty-host.js'), nativeHosts: [join(d, 'missing'), join(src, 'atelier-pty-host')] });
  expect(iso).toEqual({ execPath: '/A/Atelier', hostScript: join(paths.bin, 'pty-host.js'), nativeHost: join(paths.bin, 'atelier-pty-host') });
  expect(readFileSync(iso!.hostScript, 'utf8')).toBe('console.log(1)\n');
  expect(readFileSync(iso!.nativeHost, 'utf8')).toBe('MACHO');
  expect(statSync(iso!.nativeHost).mode & 0o777).toBe(0o700);
  expect(statSync(iso!.hostScript).mode & 0o777).toBe(0o600);
});

test('installPtyHost: no native host or no script → no isolation (terminals spawn as before)', () => {
  const d = tmp();
  const paths = daemonPaths(join(d, 'home'));
  writeFileSync(join(d, 'pty-host.js'), 'x');
  expect(installPtyHost(paths, { execPath: '/A', hostScript: join(d, 'pty-host.js'), nativeHosts: [join(d, 'nope')] })).toBeNull();
  writeFileSync(join(d, 'h'), 'MACHO');
  expect(installPtyHost(paths, { execPath: '/A', hostScript: join(d, 'missing.js'), nativeHosts: [join(d, 'h')] })).toBeNull();
});

// One file an antivirus (or anything) holds made atelierd's start fail: each file installs on its own, the previous copy
// of a failed one stays, the log says which.
test('install: a file that can’t be written is logged and keeps its previous copy; the others are still installed', () => {
  const p = daemonPaths(tmp());
  installAtelierFiles(p, join(p.home, 'none.json'));
  const zshrc = join(p.shell, 'zsh', '.zshrc');
  writeFileSync(zshrc, 'PREVIOUS');
  writeFileSync(p.settings, '{}');
  const logs: string[] = [];
  const write = (f: string, d: string | Uint8Array, m?: number) => {
    if (f === zshrc) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    writeFileAtomic(f, d, m);
  };
  expect(() => installAtelierFiles(p, join(p.home, 'none.json'), [], { log: (m) => logs.push(m), write })).not.toThrow();
  expect(readFileSync(zshrc, 'utf8')).toBe('PREVIOUS');
  expect(JSON.parse(readFileSync(p.settings, 'utf8')).hooks.Stop).toBeDefined();
  expect(readFileSync(join(p.shell, 'zsh', '.zlogin'), 'utf8')).toContain('Atelier');
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatch(/\.zshrc.*EACCES/);
});
