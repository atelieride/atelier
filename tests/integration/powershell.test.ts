import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { expect, test } from 'vitest';
import { ATELIER_PS1, powerShellArgs } from '../../src/daemon/install-files';
import { isWin } from '../support/platform';

// Atelier's PowerShell integration in a real ConPTY (Windows only): the initial command, the claude function's
// --settings rule, the command marks with the terminal's nonce, OSC 7.

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NONCE = '0123456789abcdef0123456789abcdef';

function run(init: string, extra: Record<string, string> = {}): Promise<{ out: string; argv: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'atl-ps-'));
  const script = join(dir, 'atelier.ps1');
  writeFileSync(script, ATELIER_PS1);
  const settings = join(dir, 'claude-settings.json');
  writeFileSync(settings, '{}');
  // A fake claude: writes its arguments to a file.
  const fake = join(dir, 'claude.cmd');
  const argv = join(dir, 'argv.txt');
  writeFileSync(fake, `@echo %*> "${argv}"\r\n`);
  writeFileSync(argv, '');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>), ATELIER_CLAUDE_BIN: fake, ATELIER_SOCK: '\\\\.\\pipe\\atelier-test',
    ATELIER_CLAUDE_SETTINGS: settings, ATELIER_INIT_CMD: init, ATELIER_MARK_NONCE: NONCE, ...extra
  };
  return new Promise((resolve, reject) => {
    const p = pty.spawn(POWERSHELL, powerShellArgs(script), { name: 'xterm-256color', cols: 200, rows: 30, cwd: dir, env });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; output so far: ${JSON.stringify(out)}`)); }, 30_000);
    p.onData((d) => {
      out += d;
      // Ready for input after the init command: run one more command (C/D marks), then leave.
      if (out.includes(`133;B;atelier=${NONCE}`) && !out.includes('ATL-DONE')) { out += 'ATL-DONE'; p.write('cmd /c exit 3\r'); setTimeout(() => p.write('exit\r'), 1500); }
    });
    p.onExit(() => { clearTimeout(timer); resolve({ out, argv: readFileSync(argv, 'utf8').trim() }); });
  });
}

test.runIf(isWin)('a session command gets Atelier’s settings; marks carry the nonce; the cwd is reported', async () => {
  const r = await run('claude --name=x');
  expect(r.argv).toMatch(/^--settings .*claude-settings\.json --name=x$/);
  expect(r.out).toContain(`\x1b]133;A;atelier=${NONCE}\x07`);
  expect(r.out).toContain(`\x1b]133;C;atelier=${NONCE}\x07`);
  expect(r.out).toContain(`\x1b]133;D;3;atelier=${NONCE}\x07`);
  expect(r.out).toMatch(/\x1b\]7;file:\/\/\/[A-Z]:\//);
}, 60_000);

test.runIf(isWin)('subcommands and --print run without the settings', async () => {
  expect((await run('claude mcp list')).argv).toBe('mcp list');
  expect((await run('claude -p hi')).argv).toBe('-p hi');
}, 90_000);

test.runIf(isWin)('a prompt of the user’s own (oh-my-posh, starship) still sees whether the last command failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-ps-'));
  writeFileSync(join(dir, 'atelier.ps1'), ATELIER_PS1);
  // The user's profile defines a prompt reading $?, then Atelier's integration loads (as after a real $PROFILE).
  writeFileSync(join(dir, 'with-profile.ps1'), `function global:prompt { 'LAST=' + $? + '> ' }\r\n. '${join(dir, 'atelier.ps1')}'\r\n`);
  const env = { ...(process.env as Record<string, string>), ATELIER_MARK_NONCE: NONCE };
  const out = await new Promise<string>((resolve, reject) => {
    const p = pty.spawn(POWERSHELL, powerShellArgs(join(dir, 'with-profile.ps1')), { name: 'xterm-256color', cols: 200, rows: 30, cwd: dir, env });
    let o = '';
    let step = 0;
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${JSON.stringify(o)}`)); }, 30_000);
    p.onData((d) => {
      o += d;
      if (step === 0 && o.includes('LAST=True')) { step = 1; p.write('cmd /c exit 3\r'); }
      else if (step === 1 && o.includes('LAST=False')) { step = 2; p.write('exit\r'); }
    });
    p.onExit(() => { clearTimeout(timer); resolve(o); });
  });
  expect(out).toContain('LAST=False');
}, 60_000);

/** PowerShell with Atelier's integration, an environment of the test's making; the output once it exits. */
function drive(env: Record<string, string>, args?: (script: string) => string[], until?: { see: string; then: string }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'atl-ps-'));
  const script = join(dir, 'atelier.ps1');
  writeFileSync(script, ATELIER_PS1);
  return new Promise((resolve, reject) => {
    const p = pty.spawn(POWERSHELL, (args ?? powerShellArgs)(script), { name: 'xterm-256color', cols: 400, rows: 30, cwd: dir, env: { ATELIER_HOME: dir, ...env } });
    let out = '';
    let sent = false;
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout; output so far: ${JSON.stringify(out)}`)); }, 30_000);
    p.onData((d) => {
      out += d;
      if (until && !sent && out.includes(until.see)) { sent = true; p.write(until.then); }
    });
    p.onExit(() => { clearTimeout(timer); resolve(out); });
  });
}

// The initial command runs inside the dot-sourced integration, where `exit` leaves only the script: leave at the first
// prompt (its OSC 7) instead.
const AT_PROMPT_EXIT = { see: '\x1b]7;', then: 'exit\r' };

/** The test process's environment without the named variables (any case). */
function without(...names: string[]): Record<string, string> {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !drop.has(e[0].toUpperCase())));
}

test.runIf(isWin)('your profile: no command marks, only the prompt signal atelierd reads (a killed Claude ends there too)', async () => {
  const out = await drive({ ...without('ATELIER_MARK_NONCE'), ATELIER_PROMPT_NONCE: NONCE }, undefined, { see: `133;P;atelier=${NONCE}`, then: 'exit\r' });
  expect(out).toContain(`\x1b]133;P;atelier=${NONCE}\x07`);
  expect(out).not.toMatch(/\x1b\]133;[ABCD]/);
}, 60_000);

test.runIf(isWin)('PATH and variables added to Windows’ settings after atelierd started reach a new terminal', async () => {
  // atelierd's environment from before an install: PATH without System32, no OS variable. The registry has both.
  const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const env = { ...without('PATH', 'OS'), Path: join(sys, 'WindowsPowerShell', 'v1.0') };
  const out = await drive({ ...env, ATELIER_INIT_CMD: "Write-Host ('SYS=' + (($env:Path -split ';') -contains (Join-Path $env:SystemRoot 'System32')) + ' OS=' + $env:OS + ' BIN=' + (($env:Path -split ';')[0] -eq (Join-Path $env:ATELIER_HOME 'bin')))" }, undefined, AT_PROMPT_EXIT);
  // Atelier's bin first: the bridge called by name is this Atelier's.
  expect(out).toContain('SYS=True OS=Windows_NT BIN=True');
}, 60_000);

test.runIf(isWin)('a folder your profile takes off PATH stays off: only folders new since atelierd started are added', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atl-ps-'));
  writeFileSync(join(dir, 'atelier.ps1'), ATELIER_PS1);
  const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  // The profile drops System32 (it is in the registry and was already in atelierd's PATH), then the integration loads.
  writeFileSync(join(dir, 'with-profile.ps1'), `$env:Path = (($env:Path -split ';') | Where-Object { $_ -ne '${sys}' }) -join ';'\r\n. '${join(dir, 'atelier.ps1')}'\r\n`);
  const start = `${join(sys, 'WindowsPowerShell', 'v1.0')};${sys}`;
  const env = { ...without('PATH'), Path: start, ATELIER_START_PATH: start, ATELIER_HOME: dir, ATELIER_INIT_CMD: "Write-Host ('SYS=' + (($env:Path -split ';') -contains (Join-Path $env:SystemRoot 'System32')) + ' START=' + [string]$env:ATELIER_START_PATH + '.')" };
  const out = await new Promise<string>((resolve, reject) => {
    const p = pty.spawn(POWERSHELL, powerShellArgs(join(dir, 'with-profile.ps1')), { name: 'xterm-256color', cols: 400, rows: 30, cwd: dir, env });
    let o = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${JSON.stringify(o)}`)); }, 30_000);
    p.onData((d) => { o += d; if (o.includes(AT_PROMPT_EXIT.see) && !o.includes('ATL-BYE')) { o += 'ATL-BYE'; p.write(AT_PROMPT_EXIT.then); } });
    p.onExit(() => { clearTimeout(timer); resolve(o); });
  });
  // Off PATH as the profile left it, and the variable gone once read.
  expect(out).toContain('SYS=False START=.');
}, 60_000);

test.runIf(isWin)('the refresh adds only what is missing, expanded, never a variable Atelier keeps out', async () => {
  const fresh = "__atelierFreshen @{ Path = 'C:\\atl-new;%SystemRoot%\\System32;C:\\atl-new\\'; ATL_NEW = '%ATL_BASE%\\x'; ATL_BASE = 'C:\\b'; NODE_OPTIONS = 'bad'; ATELIER_X = 'bad'; ELECTRON_RUN_AS_NODE = '1'; CLAUDE_CONFIG_DIR = 'C:\\other'; ATL_HAVE = 'new'; 'ATL=BAD' = 'x' }";
  const show = "Write-Host ('R=' + $env:ATL_NEW + '|' + $env:NODE_OPTIONS + '|' + $env:ATELIER_X + '|' + $env:ELECTRON_RUN_AS_NODE + '|' + $env:ATL_HAVE + '|' + @(($env:Path -split ';') | Where-Object { $_.TrimEnd('\\') -eq 'C:\\atl-new' }).Count + '|' + @(($env:Path -split ';') | Where-Object { $_ -eq (Join-Path $env:SystemRoot 'System32') }).Count + '|' + $env:CLAUDE_CONFIG_DIR)";
  const env = { ...without('NODE_OPTIONS', 'ATELIER_X', 'ELECTRON_RUN_AS_NODE', 'ATL_NEW', 'ATL_BASE', 'CLAUDE_CONFIG_DIR'), ATL_HAVE: 'old' };
  const out = await drive({ ...env, ATELIER_INIT_CMD: `${fresh}; ${show}` }, undefined, AT_PROMPT_EXIT);
  // A name Windows refuses (ATL=BAD) skips only itself. CLAUDE_CONFIG_DIR is the account Atelier chose: never added.
  expect(out).toContain('R=C:\\b\\x||||old|1|1|');
  expect(out).not.toContain('R=C:\\b\\x||||old|1|1|C:');
}, 60_000);

test.runIf(isWin)('a policy that beats -ExecutionPolicy Bypass (Group Policy): the terminal says why, and its command still runs', async () => {
  // AllSigned for this process stands in for the Group Policy: atelier.ps1 isn't signed.
  const signedOnly = (script: string) => powerShellArgs(script).map((a) => (a === 'Bypass' ? 'AllSigned' : a));
  // Without PSModulePath: one inherited from PowerShell 7 (CI's steps) makes Windows PowerShell load 7's PSReadLine,
  // whose publisher AllSigned asks about at the first prompt.
  const out = await drive({ ...without('ATELIER_MARK_NONCE', 'PSModulePath'), ATELIER_INIT_CMD: "Write-Host ('INIT' + '-RAN'); exit" }, signedOnly);
  expect(out).toContain('Group Policy');
  expect(out).toContain('INIT-RAN');
}, 60_000);

test.runIf(isWin)('a script the initial command runs, blocked once the integration loaded, shows its own error, not the policy notice', async () => {
  const out = await drive({ ...without('ATELIER_MARK_NONCE'), ATELIER_INIT_CMD: "throw (New-Object System.Management.Automation.PSSecurityException ('ATL' + '-SEC'))" }, undefined, AT_PROMPT_EXIT);
  expect(out).toContain('ATL-SEC');
  expect(out).not.toContain('Group Policy');
}, 60_000);

test.runIf(isWin)('in the e2e suite a real claude is refused', async () => {
  const r = await run('claude', { ATELIER_CLAUDE_BIN: '', ATELIER_E2E: '1' });
  expect(r.out).toContain('REAL-CLAUDE-BLOCKED');
  expect(r.argv).toBe('');
}, 60_000);
