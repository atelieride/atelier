import { expect, test } from 'vitest';
import { atelierMenuOnRightClick, isClaudeTerminal, programTakesF10 } from './context-menu';

test('a program that captures the mouse (tmux, vim) gets the right-click: no Atelier menu on top of its own', () => {
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'tmux', shiftKey: false })).toBe(false);
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'nvim', shiftKey: false })).toBe(false);
});

test('Atelier\'s menu otherwise, with ⇧ always, and in Claude (it has no right-click menu of its own)', () => {
  expect(atelierMenuOnRightClick({ mouseTracking: false, foreground: 'tmux', shiftKey: false })).toBe(true);
  expect(atelierMenuOnRightClick({ mouseTracking: false, foreground: 'zsh', shiftKey: false })).toBe(true);
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'tmux', shiftKey: true })).toBe(true);
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'claude', shiftKey: false })).toBe(true);
});

test('Claude shows up as its version, not as "claude": a session capturing the mouse still gets Atelier\'s menu', () => {
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: '2.1.42', shiftKey: false })).toBe(true);
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: '', shiftKey: false, session: true })).toBe(true);
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'nvim', shiftKey: false, session: false })).toBe(false);
});

test('a session terminal is Claude\'s (often under its zsh wrapper) unless an editor or tmux is in front', () => {
  expect(isClaudeTerminal({ foreground: '2.1.42', session: true })).toBe(true);
  expect(isClaudeTerminal({ foreground: '2.1.42', session: false })).toBe(true);
  expect(isClaudeTerminal({ foreground: 'node', session: true })).toBe(true);
  expect(isClaudeTerminal({ foreground: 'nvim', session: true })).toBe(false);
  // Claude starts through the shell's claude function: the foreground can read zsh while Claude runs.
  expect(isClaudeTerminal({ foreground: '/bin/zsh', session: true })).toBe(true);
  expect(isClaudeTerminal({ foreground: '/bin/zsh', session: false })).toBe(false);
  expect(isClaudeTerminal({ foreground: 'tmux', session: true })).toBe(false);
  expect(isClaudeTerminal({ foreground: 'nvim', session: false })).toBe(false);
  // vim opened by Claude captures the mouse: its right-click is its own.
  expect(atelierMenuOnRightClick({ mouseTracking: true, foreground: 'nvim', shiftKey: false, session: true })).toBe(false);
});

test('F10 goes to a full-screen program (htop, mc: the alternate screen or mouse tracking on), not to a shell or Claude', () => {
  expect(programTakesF10({ alternate: true, mouseTracking: false, foreground: 'htop' })).toBe(true);
  expect(programTakesF10({ alternate: false, mouseTracking: true, foreground: 'mc' })).toBe(true);
  expect(programTakesF10({ alternate: false, mouseTracking: false, foreground: 'bash' })).toBe(false);
  // Claude Code has no use for F10: the window's menu keeps it there.
  expect(programTakesF10({ alternate: true, mouseTracking: true, foreground: 'zsh', session: true })).toBe(false);
  expect(programTakesF10({ alternate: true, mouseTracking: false, foreground: '2.1.3' })).toBe(false);
});
