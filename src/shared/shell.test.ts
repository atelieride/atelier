import { expect, test } from 'vitest';
import { claudeCommand, claudeResumeCommand, shellQuote, withConfigDir } from './shell';

test('shellQuote', () => {
  expect(shellQuote('simple')).toBe("'simple'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(shellQuote('$(rm -rf ~) `x` "y"')).toBe("'$(rm -rf ~) `x` \"y\"'");
  expect(shellQuote('/Users/x/Library/Application Support/Atelier')).toBe("'/Users/x/Library/Application Support/Atelier'");
});
test('claudeCommand', () => {
  expect(claudeCommand()).toBe('claude');
  expect(claudeCommand('   ')).toBe('claude');
  expect(claudeCommand("Rename the user's file")).toBe("claude --name='Rename the user'\\''s file'");
  expect(claudeCommand('a\nb')).toBe("claude --name='a b'");
  // a name starting with '-' stays the value of --name, it does not become an option (e.g. -p would skip the hooks)
  expect(claudeCommand('-p')).toBe("claude --name='-p'");
  // no control character reaches the terminal (it would be a keypress: ESC, ^C, ^U…)
  expect(claudeCommand('a\x1b[2Jb\x03c\x7f')).toBe("claude --name='a[2Jbc'");
});
test('claudeCommand with the new-session settings', () => {
  expect(claudeCommand(undefined, { model: 'default', permissionMode: 'inherit' })).toBe('claude');
  expect(claudeCommand(undefined, { model: 'sonnet', permissionMode: 'inherit' })).toBe('claude --model sonnet');
  // "Ask" must really be passed: without the flag Claude would use the default mode from the user's settings (e.g. auto).
  expect(claudeCommand(undefined, { model: 'default', permissionMode: 'default' })).toBe('claude --permission-mode default');
  expect(claudeCommand(undefined, { model: 'default', permissionMode: 'auto' })).toBe('claude --permission-mode auto');
  expect(claudeCommand('Fix', { model: 'opus', permissionMode: 'plan' })).toBe("claude --name='Fix' --model opus --permission-mode plan");
  expect(claudeCommand(undefined, { model: 'default', permissionMode: 'acceptEdits' })).toBe('claude --permission-mode acceptEdits');
  // out-of-list values (never valid when coming from normalized settings) do not enter the command
  expect(claudeCommand(undefined, { model: 'x; rm -rf ~' as never, permissionMode: 'bypassPermissions' as never })).toBe('claude');
});
test('claudeResumeCommand: a session id only, with the new-session settings', () => {
  const id = '0b5c8f0e-1111-4222-8333-944455556666';
  expect(claudeResumeCommand(id)).toBe(`claude --resume '${id}'`);
  expect(claudeResumeCommand(id, { model: 'opus', permissionMode: 'plan' })).toBe(`claude --resume '${id}' --model opus --permission-mode plan`);
  expect(claudeResumeCommand(id, { model: 'default', permissionMode: 'inherit' })).toBe(`claude --resume '${id}'`);
  // Never anything but a UUID on the command line.
  expect(() => claudeResumeCommand("x'; rm -rf ~")).toThrow();
  expect(() => claudeResumeCommand(`${id}\n`)).toThrow();
});

// Claude accounts: another account starts with CLAUDE_CONFIG_DIR before claude, the default without it.
const SID = '89fcf8ea-a6ad-4f29-a390-922953c50a6c';
const plain = { model: 'default', permissionMode: 'inherit' } as const;
test('another account: CLAUDE_CONFIG_DIR before claude, quoted so nothing is interpreted', () => {
  expect(claudeCommand('x', { ...plain, configDir: "/a b/it's $(x)" })).toBe(`CLAUDE_CONFIG_DIR='/a b/it'\\''s $(x)' claude --name='x'`);
  expect(claudeResumeCommand(SID, { ...plain, configDir: '/d' })).toBe(`CLAUDE_CONFIG_DIR='/d' claude --resume '${SID}'`);
  expect(withConfigDir(`claude --resume '${SID}'`, '/d')).toBe(`CLAUDE_CONFIG_DIR='/d' claude --resume '${SID}'`);
});
test('the default account: byte-identical to before', () => {
  expect(claudeCommand('x', { model: 'opus', permissionMode: 'plan', configDir: undefined })).toBe(`claude --name='x' --model opus --permission-mode plan`);
  expect(claudeResumeCommand(SID, { model: 'opus', permissionMode: 'plan', configDir: undefined })).toBe(`claude --resume '${SID}' --model opus --permission-mode plan`);
  expect(withConfigDir('claude', undefined)).toBe('claude');
});
// Launch flags: after Atelier's own, every token quoted on its own.
test('launch flags: quoted one by one, after the settings flags', () => {
  expect(claudeCommand('x', { model: 'opus', permissionMode: 'auto', flags: [['--add-dir', "/a b/it's $(x)"], ['--verbose']] }))
    .toBe(`claude --name='x' --model opus --permission-mode auto '--add-dir' '/a b/it'\\''s $(x)' '--verbose'`);
  expect(claudeCommand('x', { ...plain, flags: [] })).toBe(`claude --name='x'`);
  expect(claudeCommand('x', { ...plain, configDir: '/d', flags: [['--ide']] })).toBe(`CLAUDE_CONFIG_DIR='/d' claude --name='x' '--ide'`);
  expect(claudeResumeCommand(SID, { model: 'opus', permissionMode: 'plan', flags: [['--ide']] })).toBe(`claude --resume '${SID}' --model opus --permission-mode plan '--ide'`);
});
test('launch flags: with --dangerously-skip-permissions Atelier leaves out its own --permission-mode', () => {
  expect(claudeCommand('x', { model: 'default', permissionMode: 'auto', flags: [['--dangerously-skip-permissions']] })).toBe(`claude --name='x' '--dangerously-skip-permissions'`);
  expect(claudeResumeCommand(SID, { model: 'default', permissionMode: 'plan', flags: [['--dangerously-skip-permissions']] })).toBe(`claude --resume '${SID}' '--dangerously-skip-permissions'`);
  expect(claudeCommand('x', { model: 'default', permissionMode: 'auto', flags: [['--dangerously-skip-permissions=true']] })).not.toContain('--permission-mode');
  // A value that merely reads like it doesn't count.
  expect(claudeCommand('x', { model: 'default', permissionMode: 'auto', flags: [['--append-system-prompt', '--dangerously-skip-permissions']] })).toContain('--permission-mode auto');
});
test('a config dir that is not a clean absolute path is refused', () => {
  for (const d of ['rel', '/a\nb', '/a/../b', '']) expect(() => claudeCommand('x', { ...plain, configDir: d }), d).toThrow();
});
