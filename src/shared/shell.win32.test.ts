import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { claudeCommand, claudeResumeCommand, profileShellKind, shellQuote, withConfigDir } from './shell';

// Commands typed into Atelier's terminals on Windows: sessions run in PowerShell, so names,
// ids and config dirs are quoted for it, and another account's dir is set for that one command only.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

const opts = { model: 'sonnet' as const, permissionMode: 'plan' as const };

test('PowerShell quoting: single quotes, every kind of single quote doubled (PowerShell ends a string on ‘ ’ too)', () => {
  expect(shellQuote("it's", 'powershell')).toBe("'it''s'");
  expect(shellQuote('a‘b’c‚d‛', 'powershell')).toBe("'a‘‘b’’c‚‚d‛‛'");
  expect(shellQuote('$HOME `x`', 'powershell')).toBe("'$HOME `x`'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
});

test('cmd quoting: double quotes; what cmd would still expand is refused', () => {
  expect(shellQuote('C:\\a b\\c.txt', 'cmd')).toBe('"C:\\a b\\c.txt"');
  for (const bad of ['a"b', '%PATH%', 'a!b']) expect(() => shellQuote(bad, 'cmd')).toThrow();
});

test('a new session on Windows: the name quoted for PowerShell, double quotes dropped (PowerShell 5.1 mangles them)', () => {
  expect(claudeCommand("Ada's fix", opts)).toBe("claude --name='Ada''s fix' --model sonnet --permission-mode plan");
  expect(claudeCommand('say "hi"')).toBe("claude --name='say hi'");
  // A trailing backslash would escape the quote PowerShell 5.1 adds and swallow the next flags (an automation's
  // permission mode, deny rules…); % would reach npm's claude.cmd as a variable. Both go.
  expect(claudeCommand('CU-1 Fix C:\\tmp\\', opts)).toBe("claude --name='CU-1 Fix C:tmp' --model sonnet --permission-mode plan");
  expect(claudeCommand('100% done')).toBe("claude --name='100 done'");
});

test("a name on Windows: what npm's claude.cmd would hand to cmd unquoted (no space in the word) goes too", () => {
  expect(claudeCommand('R&D')).toBe("claude --name='RD'");
  expect(claudeCommand('a|b<c>d^e')).toBe("claude --name='abcde'");
});

test('launch flags on Windows: each token quoted for PowerShell, inside the account wrapper', () => {
  expect(claudeCommand('x', { ...opts, configDir: 'C:/Users/m/.claude-work', flags: [['--add-dir', "C:\\Users\\m\\it's"]] })).toBe(
    "& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = 'C:/Users/m/.claude-work'; try { claude --name='x' --model sonnet --permission-mode plan '--add-dir' 'C:\\Users\\m\\it''s' } finally { $env:CLAUDE_CONFIG_DIR = $p } }"
  );
});

test('another account on Windows: the dir set for this command only, then given back', () => {
  expect(withConfigDir('claude', 'C:/Users/m/.claude-work')).toBe(
    "& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = 'C:/Users/m/.claude-work'; try { claude } finally { $env:CLAUDE_CONFIG_DIR = $p } }"
  );
  expect(claudeResumeCommand('0a1b2c3d-1111-2222-3333-444455556666', { ...opts, configDir: 'C:/Users/m/.claude-work' })).toBe(
    "& { $p = $env:CLAUDE_CONFIG_DIR; $env:CLAUDE_CONFIG_DIR = 'C:/Users/m/.claude-work'; try { claude --resume '0a1b2c3d-1111-2222-3333-444455556666' --model sonnet --permission-mode plan } finally { $env:CLAUDE_CONFIG_DIR = $p } }"
  );
  expect(() => withConfigDir('claude', 'C:/Users/m/../x')).toThrow();
});

test('the shell kind of a terminal profile', () => {
  initPlatform('win32');
  expect(profileShellKind('atelier')).toBe('powershell');
  expect(profileShellKind(undefined)).toBe('powershell');
  expect(profileShellKind({ shell: 'C:/Program Files/PowerShell/7/pwsh.exe' })).toBe('powershell');
  expect(profileShellKind({ shell: 'C:/WINDOWS/System32/cmd.exe' })).toBe('cmd');
  expect(profileShellKind({ shell: 'C:/Program Files/Git/bin/bash.exe' })).toBe('posix');
  initPlatform('darwin');
  expect(profileShellKind('user')).toBe('posix');
  expect(profileShellKind({ shell: '/bin/bash' })).toBe('posix');
});

test('macOS: exactly as before', () => {
  initPlatform('darwin');
  expect(claudeCommand("Ada's fix", opts)).toBe("claude --name='Ada'\\''s fix' --model sonnet --permission-mode plan");
  expect(claudeCommand('say "hi"')).toBe("claude --name='say \"hi\"'");
  expect(withConfigDir('claude', '/Users/m/.claude-work')).toBe("CLAUDE_CONFIG_DIR='/Users/m/.claude-work' claude");
});
