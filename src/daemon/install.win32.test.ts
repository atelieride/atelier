import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { daemonPaths } from '@shared/paths.node';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { writeFileAtomic } from './fsutil';
import { HOOK_EVENTS, WINDOWS_HOOK_TIMEOUT_S, bridgeCommand, buildWindowsClaudeSettings, installAtelierFiles, installBridge, readUserStatusLine } from './install';

afterEach(() => resetPlatformForTests());

// Claude Code's settings on Windows: every hook and the status line run atelier-bridge.exe.
// Claude runs them through Git Bash when it finds one (Program Files, a per-user install, git on PATH, its own
// variable), else PowerShell: a path without spaces works in both as is. A path that needs quoting has no form both
// shells read, and guessing Claude's shell went wrong for a per-user Git: the bridge is then called by name
// (atelier.ps1 puts ATELIER_HOME\bin on the terminal's PATH).

test('a path without spaces: forward slashes, no quotes, in either shell', () => {
  expect(bridgeCommand('C:\\Users\\mario\\.atelier\\bin\\atelier-bridge.exe', 'hook')).toBe('C:/Users/mario/.atelier/bin/atelier-bridge.exe hook');
  expect(bridgeCommand('C:\\Users\\mario.rossi-2_x\\b.exe', 'status')).toBe('C:/Users/mario.rossi-2_x/b.exe status');
});

test('a path that needs quoting (a space, an apostrophe, anything a shell reads): the bridge by name, whatever shell runs it', () => {
  for (const name of ['Mario Rossi', "D'Angelo", "O'Brien X", 'M&M', 'Luca$', 'Rossi(Work)', 'a;b', 'a,b', 'a`b', 'a{b}', 'a@b', 'a#b', 'a!b']) {
    expect(bridgeCommand(`C:\\Users\\${name}\\.atelier\\bin\\atelier-bridge.exe`, 'hook'), name).toBe('atelier-bridge hook');
    expect(bridgeCommand(`C:\\Users\\${name}\\.atelier\\bin\\atelier-bridge.exe`, 'status'), name).toBe('atelier-bridge status');
  }
});

test('a bridge still running (a hook in flight while atelierd restarts) can’t be replaced: the previous one stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-br-'));
  const src = join(dir, 'new.exe');
  writeFileSync(src, 'new');
  writeFileSync(join(dir, 'atelier-bridge.exe'), 'old');
  const busy = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  expect(installBridge(dir, [src], busy)).toBe(join(dir, 'atelier-bridge.exe'));
  expect(readFileSync(join(dir, 'atelier-bridge.exe'), 'utf8')).toBe('old');
  // No bridge at all yet and none can be written: none.
  const empty = mkdtempSync(join(tmpdir(), 'atl-br-'));
  expect(installBridge(empty, [src], busy)).toBe(null);
  expect(installBridge(empty, [join(empty, 'missing.exe')])).toBe(null);
});

test('every hook event and the status line go through the bridge, with the user’s options', () => {
  const s = buildWindowsClaudeSettings('C:\\Users\\m\\.atelier\\bin\\atelier-bridge.exe', { command: 'x', refreshInterval: 30, padding: 0 }) as {
    hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>;
    statusLine: Record<string, unknown>;
  };
  expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  for (const ev of HOOK_EVENTS) expect(s.hooks[ev]).toEqual([{ hooks: [{ type: 'command', command: 'C:/Users/m/.atelier/bin/atelier-bridge.exe hook', timeout: WINDOWS_HOOK_TIMEOUT_S }] }]);
  expect(s.statusLine).toEqual({ type: 'command', command: 'C:/Users/m/.atelier/bin/atelier-bridge.exe status', refreshInterval: 30, padding: 0 });
});

// A field report: hooks never reached atelierd on a Store user's PC while the status line did. Claude runs each hook
// through Git Bash (or PowerShell), which then starts the bridge: with an antivirus scanning both, a cold start alone
// can pass 2 s, Claude kills the hook and the session never gets a state. The bridge bounds its own wait (~2 s to
// connect, 1.9 s for the reply: native/atelier-bridge.c), so the cap only has to leave room for the shells' start.
test('Windows hooks get room for Git Bash and the bridge to start under an antivirus: well above the bridge’s own ~4 s', () => {
  expect(WINDOWS_HOOK_TIMEOUT_S).toBe(10);
  const s = buildWindowsClaudeSettings('C:\\a\\atelier-bridge.exe', null) as { hooks: Record<string, { hooks: { timeout: number }[] }[]> };
  for (const ev of HOOK_EVENTS) expect(s.hooks[ev]![0]!.hooks[0]!.timeout).toBe(10);
});

// Windows PowerShell 5.1's `Set-Content -Encoding UTF8` starts the file with a BOM, which JSON.parse refuses: the user's
// status line vanished inside Atelier.
test('a settings file that starts with a UTF-8 BOM still gives the user’s status line', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'atl-bom-')), 'settings.json');
  writeFileSync(f, '\uFEFF' + JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/s.sh', padding: 0 } }));
  expect(readUserStatusLine(f)).toEqual({ command: 'bash ~/s.sh', padding: 0 });
});

// A field report: an antivirus (or Smart App Control) quarantined the runtime copy's bridge; atelierd then wrote empty
// Claude settings, silently, although a good bridge was still installed in bin/ from an earlier start.
test('no bridge in the runtime: the one already installed in bin/ stays in use, and the log says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-br-'));
  writeFileSync(join(dir, 'atelier-bridge.exe'), 'old');
  const logs: string[] = [];
  expect(installBridge(dir, [join(dir, 'gone.exe')], writeFileAtomic, (m) => logs.push(m))).toBe(join(dir, 'atelier-bridge.exe'));
  expect(readFileSync(join(dir, 'atelier-bridge.exe'), 'utf8')).toBe('old');
  expect(logs.join('\n')).toMatch(/atelier-bridge\.exe missing .*gone\.exe.*installed copy/);
});

test('no bridge anywhere: none, and the log says sessions will show no states', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-br-'));
  const logs: string[] = [];
  expect(installBridge(dir, [join(dir, 'gone.exe')], writeFileAtomic, (m) => logs.push(m))).toBe(null);
  expect(logs.join('\n')).toMatch(/no atelier-bridge\.exe.*no states/);
});

test('a bridge that can’t be read (an antivirus holding it): the installed one stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-br-'));
  writeFileSync(join(dir, 'atelier-bridge.exe'), 'old');
  mkdirSync(join(dir, 'locked.exe'));
  const logs: string[] = [];
  expect(installBridge(dir, [join(dir, 'locked.exe')], writeFileAtomic, (m) => logs.push(m))).toBe(join(dir, 'atelier-bridge.exe'));
  expect(logs).toHaveLength(1);
});

test('Windows install: Claude’s settings point at the installed bridge when the runtime lost its own', () => {
  const p = daemonPaths(mkdtempSync(join(tmpdir(), 'atl-iw-')));
  initPlatform('win32');
  mkdirSync(p.bin, { recursive: true });
  writeFileSync(join(p.bin, 'atelier-bridge.exe'), 'old');
  installAtelierFiles(p, join(p.home, 'none.json'), [join(p.home, 'gone.exe')]);
  expect(Object.keys(JSON.parse(readFileSync(p.settings, 'utf8')).hooks ?? {})).toEqual([...HOOK_EVENTS]);
});

// One file an antivirus holds past writeFileAtomic's retries made atelierd's start fail ("atelierd did not start"):
// each file now installs on its own, the previous copy of a failed one stays.
test('Windows install: a file that can’t be written is logged and skipped, the others are still installed', () => {
  const p = daemonPaths(mkdtempSync(join(tmpdir(), 'atl-iw-')));
  initPlatform('win32');
  const src = join(p.home, 'src.exe');
  writeFileSync(src, 'bridge');
  const logs: string[] = [];
  const write = (f: string, d: string | Uint8Array, m?: number) => {
    if (f.endsWith('atelier.ps1')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    writeFileAtomic(f, d, m);
  };
  expect(() => installAtelierFiles(p, join(p.home, 'none.json'), [src], { log: (m) => logs.push(m), write })).not.toThrow();
  expect(existsSync(join(p.shell, 'atelier.ps1'))).toBe(false);
  expect(readFileSync(join(p.bin, 'atelier-bridge.exe'), 'utf8')).toBe('bridge');
  expect(JSON.parse(readFileSync(p.settings, 'utf8')).hooks.Stop).toBeDefined();
  expect(logs.join('\n')).toMatch(/atelier\.ps1.*EBUSY/);
});
