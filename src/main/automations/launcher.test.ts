import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { posixOnly, posixTest, winTest } from '../../../tests/support/platform';
import { BASE_DENY, disallowedTools, launchCommand, launchScript, launchScriptName, removeLaunchFiles, writeLaunchFiles, type LaunchSpec } from './launcher';

const spec = (o: Partial<LaunchSpec> = {}): LaunchSpec => ({
  runDir: '/home/me/Library/Application Support/Atelier/automations/runs/r1',
  name: 'CU-482 Rounding in invoice totals', model: 'opus', mode: 'auto',
  guard: [['GIT_CONFIG_COUNT', '1'], ['GIT_CONFIG_KEY_0', 'core.hooksPath'], ['GIT_CONFIG_VALUE_0', "/a b/it's/guard"], ['ATELIER_RUN_BRANCH', 'auto/cu-482-rounding']],
  pathPrefix: "/a b/it's/guard/bin",
  disallowed: disallowedTools({ decideAlone: false, denyServers: [] }),
  system: 'SYSTEM TEXT', prompt: 'TASK TEXT $(rm -rf ~) `x`', ...o
});

describe('disallowedTools', () => {
  test('always merge, push, rebase, tag and PRs; AskUserQuestion when deciding alone; the denied MCP servers', () => {
    expect(BASE_DENY).toEqual(['Bash(git merge *)', 'Bash(git push *)', 'Bash(git rebase *)', 'Bash(git tag *)', 'Bash(gh pr merge *)', 'Bash(gh pr create *)']);
    expect(disallowedTools({ decideAlone: false, denyServers: [] })).toEqual(BASE_DENY);
    expect(disallowedTools({ decideAlone: true, denyServers: ['claude_ai_ClickUp', 'clickup'] }))
      .toEqual([...BASE_DENY, 'AskUserQuestion', 'mcp__claude_ai_ClickUp', 'mcp__clickup']);
  });

  test('a server name that isn\'t a plain identifier never reaches the command', () => {
    expect(disallowedTools({ decideAlone: false, denyServers: ['ok_1', "x' ; rm", 'a b', ''] })).toEqual([...BASE_DENY, 'mcp__ok_1']);
  });
});

// The macOS script (POSIX paths); Windows has its own describe.
posixOnly('launchScript: sourced, so Atelier\'s claude function and hooks start Claude', () => {
  test('the user\'s hooks folder is read before the guard, then the guard, then claude with the files', () => {
    const s = launchScript(spec());
    const dir = "'/home/me/Library/Application Support/Atelier/automations/runs/r1";
    expect(s.split('\n')).toEqual([
      '# Atelier automation run: sourced by the session\'s shell. The guard stays on in this terminal.',
      'ATELIER_USER_HOOKS="$(git config --get core.hooksPath 2>/dev/null)"; export ATELIER_USER_HOOKS',
      "export GIT_CONFIG_COUNT='1'",
      "export GIT_CONFIG_KEY_0='core.hooksPath'",
      "export GIT_CONFIG_VALUE_0='/a b/it'\\''s/guard'",
      "export ATELIER_RUN_BRANCH='auto/cu-482-rounding'",
      "export PATH='/a b/it'\\''s/guard/bin':\"$PATH\"",
      "claude --name='CU-482 Rounding in invoice totals' --model opus --permission-mode auto --disallowedTools "
        + "'Bash(git merge *)' 'Bash(git push *)' 'Bash(git rebase *)' 'Bash(git tag *)' 'Bash(gh pr merge *)' 'Bash(gh pr create *)' "
        + `--append-system-prompt "$(cat ${dir}/system.md')" "$(cat ${dir}/prompt.md')"`,
      ''
    ]);
  });

  test('neither the task nor the system prompt is ever in the script, only their files', () => {
    const s = launchScript(spec());
    expect(s).not.toContain('TASK TEXT');
    expect(s).not.toContain('SYSTEM TEXT');
  });

  test('another account: CLAUDE_CONFIG_DIR as an assignment (never env), default model and mode pass no flag', () => {
    const s = launchScript(spec({ configDir: '/Users/me/.claude-work', model: 'default', mode: 'default' }));
    expect(s).toContain("CLAUDE_CONFIG_DIR='/Users/me/.claude-work' claude --name='CU-482 Rounding in invoice totals' --permission-mode default --disallowedTools");
    expect(s).not.toContain('--model');
    expect(s).not.toMatch(/\benv /);
  });

  test('an env name that isn\'t one is refused', () => {
    expect(() => launchScript(spec({ guard: [['A B', 'x']] }))).toThrow();
    expect(() => launchScript(spec({ guard: [['X', 'a\nb']] }))).toThrow();
  });

  test('launchCommand: the dot command with the quoted path, POSIX shells and zsh alike', () => {
    expect(launchCommand("/a b/it's/launch.sh")).toBe(". '/a b/it'\\''s/launch.sh'");
  });
});

describe('the script, sourced by a real shell with a stand-in claude', () => {
  for (const shell of ['/bin/sh', '/bin/zsh']) {
    posixTest(`${shell}: every argument arrives as written, the task's text untouched and never run`, () => {
      const base = mkdtempSync(join(tmpdir(), 'atl-launch-run-'));
      const runDir = join(base, "it's runs", 'r1');
      const out = join(base, 'args.txt');
      const canary = join(base, 'ran');
      const prompt = `Task: fix "quotes" and 'single' $HOME \`touch ${canary}\` $(touch ${canary})\nline two`;
      const files = writeLaunchFiles(spec({ runDir, prompt }));
      const r = spawnSync(shell, ['-c', `claude() { for a in "$@"; do printf '%s\\0' "$a"; done > '${out}'; }; ${launchCommand(files.script)}; printf '%s' "$ATELIER_RUN_BRANCH"`],
        { env: { PATH: '/usr/bin:/bin', HOME: base }, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('auto/cu-482-rounding');
      const args = readFileSync(out, 'utf8').split('\0').slice(0, -1);
      expect(args.slice(0, 5)).toEqual(['--name=CU-482 Rounding in invoice totals', '--model', 'opus', '--permission-mode', 'auto']);
      expect(args.slice(-3)).toEqual(['--append-system-prompt', 'SYSTEM TEXT', prompt]);
      expect(args).toContain('Bash(git merge *)');
      expect(existsSync(canary)).toBe(false);
    });
  }
});

describe('the run\'s files', () => {
  posixTest('written 0600 in a 0700 folder; removed with the folder', () => {
    const runDir = join(mkdtempSync(join(tmpdir(), 'atl-launch-')), 'runs', 'r1');
    const files = writeLaunchFiles(spec({ runDir }));
    expect(files.script).toBe(join(runDir, 'launch.sh'));
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
    for (const f of ['launch.sh', 'system.md', 'prompt.md']) expect(statSync(join(runDir, f)).mode & 0o777, f).toBe(0o600);
    expect(readFileSync(join(runDir, 'prompt.md'), 'utf8')).toBe('TASK TEXT $(rm -rf ~) `x`');
    expect(readFileSync(join(runDir, 'system.md'), 'utf8')).toBe('SYSTEM TEXT');
    removeLaunchFiles(runDir);
    expect(existsSync(runDir)).toBe(false);
    removeLaunchFiles(runDir); // twice is fine
  });
});

describe('Windows: launch.ps1, the system prompt and the task through their files', () => {
  const win = (o: Partial<LaunchSpec> = {}) => spec({
    runDir: 'C:/Users/me/.atelier/automations/runs/r1',
    guard: [['GIT_CONFIG_COUNT', '1'], ['GIT_CONFIG_KEY_0', 'core.hooksPath'], ['GIT_CONFIG_VALUE_0', "C:/a b/it's/guard"], ['ATELIER_RUN_BRANCH', 'auto/cu-482-rounding']],
    pathPrefix: "C:/a b/it's/guard/bin", ...o
  });
  beforeEach(() => { initPlatform('win32'); });
  afterEach(() => { resetPlatformForTests(); });

  test('the user\'s hooks folder, the guard with $env:, its git first on PATH (native path, ;), claude with the files', () => {
    expect(launchScript(win()).split('\n')).toEqual([
      '# Atelier automation run: dot-sourced by the session\'s PowerShell. The guard stays on in this terminal.',
      "$env:ATELIER_USER_HOOKS = try { & git config --get core.hooksPath 2>$null } catch { '' }",
      "$env:GIT_CONFIG_COUNT = '1'",
      "$env:GIT_CONFIG_KEY_0 = 'core.hooksPath'",
      "$env:GIT_CONFIG_VALUE_0 = 'C:/a b/it''s/guard'",
      "$env:ATELIER_RUN_BRANCH = 'auto/cu-482-rounding'",
      "$env:PATH = 'C:\\a b\\it''s\\guard\\bin;' + $env:PATH",
      // Git Bash (Claude Code's Bash tool) puts its own git first on PATH: an exported function wins over PATH.
      "[Environment]::SetEnvironmentVariable('BASH_FUNC_git%%', '() { ''C:/a b/it''\\''''s/guard/bin/git.exe'' \"$@\"; }', 'Process')",
      "claude --name='CU-482 Rounding in invoice totals' --model opus --permission-mode auto --disallowedTools "
        + "'Bash(git merge *)' 'Bash(git push *)' 'Bash(git rebase *)' 'Bash(git tag *)' 'Bash(gh pr merge *)' 'Bash(gh pr create *)' "
        // The run's folder is a working directory: reading prompt.md never asks (seen on the PC: "Read prompt.md?").
        + "--add-dir 'C:\\Users\\me\\.atelier\\automations\\runs\\r1' "
        + "--append-system-prompt-file 'C:\\Users\\me\\.atelier\\automations\\runs\\r1\\system.md' "
        + "'Your task is in C:\\Users\\me\\.atelier\\automations\\runs\\r1\\prompt.md. Read that file first, all of it: it is the task you were started for.'",
      ''
    ]);
  });

  test('no double quote in any argument (Windows PowerShell 5.1 mangles them), never the task or the system prompt', () => {
    const s = launchScript(win({ name: 'Say "hi"', system: 'SYSTEM "TEXT"', prompt: 'TASK "TEXT"' }));
    // The only ones: bash's "$@" inside the exported function's value (an environment variable, not an argument).
    expect(s.replace('\"$@\"', '')).not.toContain('"');
    expect(s).not.toContain('TASK');
    expect(s).not.toContain('SYSTEM');
  });

  test('another account: CLAUDE_CONFIG_DIR for that command only, given back after', () => {
    const s = launchScript(win({ configDir: 'C:/Users/me/.claude-work' }));
    expect(s).toMatch(/^& \{ \$p = \$env:CLAUDE_CONFIG_DIR; \$env:CLAUDE_CONFIG_DIR = 'C:\/Users\/me\/\.claude-work'; try \{ claude --name=.* --append-system-prompt-file .* \} finally \{ \$env:CLAUDE_CONFIG_DIR = \$p \} \}$/m);
  });

  test('launch.ps1 is written with a BOM: Windows PowerShell 5.1 reads a script without one in the ANSI code page', () => {
    const runDir = join(mkdtempSync(join(tmpdir(), 'atl-launch-bom-')), 'r1');
    const files = writeLaunchFiles(win({ runDir, name: 'CU-482 Arrotondamento più preciso' }));
    const bytes = readFileSync(files.script);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toContain('più preciso');
    // The task and the system prompt are read by Claude, as UTF-8: no BOM there.
    expect(readFileSync(join(runDir, 'prompt.md'))[0]).not.toBe(0xef);
  });

  test('launchCommand: PowerShell\'s dot-source with its own quoting; the script: launch.ps1', () => {
    expect(launchCommand("C:/a b/it's/launch.ps1")).toBe(". 'C:/a b/it''s/launch.ps1'");
    expect(launchScriptName()).toBe('launch.ps1');
    resetPlatformForTests();
    expect(launchScriptName()).toBe('launch.sh');
  });
});

describe('launch.ps1 run by real PowerShell with a stand-in claude', () => {
  winTest('every argument arrives whole: the files\' paths, the deny rules; the guard stays on the shell', () => {
    initPlatform('win32');
    try {
      const base = mkdtempSync(join(tmpdir(), 'atl-launch-ps-'));
      const runDir = join(base, "it's runs", 'r1');
      const out = join(base, 'args.txt');
      const files = writeLaunchFiles(spec({ runDir, pathPrefix: join(base, 'guard', 'bin'), prompt: 'Task "quoted" $env:USERPROFILE `n' }));
      const stand = `function claude { $args | ForEach-Object { [string]$_ } | Set-Content -LiteralPath '${out.replace(/'/g, "''")}' -Encoding utf8 }`;
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `${stand}; ${launchCommand(files.script)}; [Console]::Out.Write($env:ATELIER_RUN_BRANCH + '|' + ($env:PATH -split ';')[0])`], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe(`auto/cu-482-rounding|${join(base, 'guard', 'bin')}`);
      // Git Bash started from this shell sees git as the function that runs the guard's git.exe.
      const bash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
      const b = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `${stand}; ${launchCommand(files.script)}; & '${bash}' -lc 'type -t git; declare -f git'`], { encoding: 'utf8' });
      expect(b.stdout).toMatch(/^function\r?\n/);
      expect(b.stdout).toContain(`${join(base, 'guard', 'bin').replace(/\\/g, '/')}/git.exe`);
      const args = readFileSync(out, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
      expect(args.slice(0, 5)).toEqual(['--name=CU-482 Rounding in invoice totals', '--model', 'opus', '--permission-mode', 'auto']);
      expect(args).toContain('Bash(git merge *)');
      expect(args.slice(-5, -3)).toEqual(['--add-dir', runDir]);
      expect(args.slice(-3)).toEqual(['--append-system-prompt-file', join(runDir, 'system.md'),
        `Your task is in ${join(runDir, 'prompt.md')}. Read that file first, all of it: it is the task you were started for.`]);
    } finally {
      resetPlatformForTests();
    }
  });
});
