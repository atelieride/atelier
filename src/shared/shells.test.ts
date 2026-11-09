import { expect, test } from 'vitest';
import { isClaudeProcess, isEditorOrPager, isShell } from './shells';

test.each([['zsh', true], ['-zsh', true], ['bash', true], ['-bash', true], ['sh', true], ['fish', true], ['login', true],
  ['/bin/zsh', true], ['/opt/homebrew/bin/fish', true], ['-/bin/zsh', true], ['/usr/bin/node', false], ['node', false], ['claude', false], ['2.1.296', false], ['tmux', false], ['perl', false], ['', false]])('%s → %s', (n, v) => expect(isShell(n)).toBe(v));

test('editors and pagers in the foreground (vim opened by Claude with Ctrl+G): they are not Claude', () => {
  for (const fg of ['vim', '/usr/bin/nvim', 'nano', 'emacs', 'hx', 'less', 'vi', 'micro']) expect(isEditorOrPager(fg)).toBe(true);
  for (const fg of ['claude', '2.1.296', 'node', 'zsh']) expect(isEditorOrPager(fg)).toBe(false);
});

test('no foreground name at all (undefined from an older atelierd): neither a shell nor an editor, no throw', () => {
  expect(isShell(undefined as unknown as string)).toBe(false);
  expect(isEditorOrPager(undefined as unknown as string)).toBe(false);
});

test('Claude Code runs under its version as the process name (2.1.42), or as claude', () => {
  expect(isClaudeProcess('2.1.42')).toBe(true);
  expect(isClaudeProcess('/usr/local/bin/2.0.7')).toBe(true);
  expect(isClaudeProcess('claude')).toBe(true);
  expect(isClaudeProcess('zsh')).toBe(false);
  expect(isClaudeProcess('python3.12')).toBe(false);
  expect(isClaudeProcess('')).toBe(false);
});
