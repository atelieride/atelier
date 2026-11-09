import { expect, test } from 'vitest';
import { blockJumpKey, claudeTakesKeys, keyOverride, terminalFindKey } from './keys';

const ev = (o: Partial<{ type: string; key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }>) =>
  ({ type: 'keydown', key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...o });

test('Shift+Enter inserts a newline in Claude Code: ESC + Enter, like its /terminal-setup for VS Code and Zed', () => {
  expect(keyOverride(true, ev({ shiftKey: true }))).toEqual({ send: '\x1b\r' });
});

test('on the other Shift+Enter events nothing is sent but xterm must not send its own Enter', () => {
  expect(keyOverride(true, ev({ shiftKey: true, type: 'keypress' }))).toEqual({ send: null });
  expect(keyOverride(true, ev({ shiftKey: true, type: 'keyup' }))).toEqual({ send: null });
});

test('plain Enter, other combinations and composition (IME) are left to xterm', () => {
  expect(keyOverride(true, ev({}))).toBeNull();
  expect(keyOverride(true, ev({ shiftKey: true, metaKey: true }))).toBeNull();
  expect(keyOverride(true, ev({ shiftKey: true, ctrlKey: true }))).toBeNull();
  expect(keyOverride(true, ev({ shiftKey: true, altKey: true }))).toBeNull();
  expect(keyOverride(true, ev({ shiftKey: true, isComposing: true }))).toBeNull();
  expect(keyOverride(true, ev({ shiftKey: true, key: 'a' }))).toBeNull();
});

test('outside Claude (shell, vim…) Shift+Enter is left to xterm: in vim ESC would leave insert mode', () => {
  expect(keyOverride(false, ev({ shiftKey: true }))).toBeNull();
});

test('Claude takes Shift+Enter in a session terminal and wherever Claude Code is the foreground process, hooks or not', () => {
  // A session terminal: Claude starts through the shell's claude function, so the foreground can still read zsh.
  expect(claudeTakesKeys({ foreground: 'zsh', session: true })).toBe(true);
  expect(claudeTakesKeys({ foreground: '2.1.42', session: true })).toBe(true);
  // claude typed in a terminal whose shell has no Atelier function (bash, fish, a plain zsh profile) or run by its path:
  // no hooks, no session, but Claude Code is in front under its version (or `claude`).
  expect(claudeTakesKeys({ foreground: '2.1.42', session: false })).toBe(true);
  expect(claudeTakesKeys({ foreground: '/Users/x/.local/bin/claude', session: false })).toBe(true);
  // The $EDITOR Claude opened (Ctrl+G), a shell, anything else: xterm's own Enter.
  expect(claudeTakesKeys({ foreground: 'nvim', session: true })).toBe(false);
  expect(claudeTakesKeys({ foreground: 'zsh', session: false })).toBe(false);
  expect(claudeTakesKeys({ foreground: 'vim', session: false })).toBe(false);
  expect(claudeTakesKeys({ foreground: 'node', session: false })).toBe(false);
});

test('⌘← / ⌘→ go to the start / end of the line: Home / End, in every program (xterm.js sends nothing for them)', () => {
  expect(keyOverride(false, ev({ key: 'ArrowLeft', metaKey: true }))).toEqual({ send: '\x1b[H' });
  expect(keyOverride(false, ev({ key: 'ArrowRight', metaKey: true }))).toEqual({ send: '\x1b[F' });
  expect(keyOverride(true, ev({ key: 'ArrowLeft', metaKey: true }))).toEqual({ send: '\x1b[H' });
  // Application cursor mode (vim, less…): Home / End as those programs expect them, like xterm's own Home key.
  expect(keyOverride(false, ev({ key: 'ArrowLeft', metaKey: true }), true)).toEqual({ send: '\x1bOH' });
  expect(keyOverride(false, ev({ key: 'ArrowRight', metaKey: true }), true)).toEqual({ send: '\x1bOF' });
  expect(keyOverride(false, ev({ key: 'ArrowLeft', metaKey: true, type: 'keyup' }))).toEqual({ send: null });
});

test('other arrow combinations stay with xterm (⌥← by word, ⇧⌘← for selection, plain arrows)', () => {
  expect(keyOverride(false, ev({ key: 'ArrowLeft' }))).toBeNull();
  expect(keyOverride(false, ev({ key: 'ArrowLeft', altKey: true }))).toBeNull();
  expect(keyOverride(false, ev({ key: 'ArrowLeft', metaKey: true, shiftKey: true }))).toBeNull();
  expect(keyOverride(false, ev({ key: 'ArrowRight', metaKey: true, ctrlKey: true }))).toBeNull();
  expect(keyOverride(false, ev({ key: 'ArrowUp', metaKey: true }))).toBeNull();
  expect(keyOverride(false, ev({ key: 'ArrowLeft', metaKey: true, isComposing: true }))).toBeNull();
});

test('⌘↑ / ⌘↓: previous / next command (command blocks) on keydown; other events and combinations are not it', () => {
  expect(blockJumpKey(ev({ key: 'ArrowUp', metaKey: true }))).toBe('prev');
  expect(blockJumpKey(ev({ key: 'ArrowDown', metaKey: true }))).toBe('next');
  expect(blockJumpKey(ev({ key: 'ArrowUp', metaKey: true, type: 'keyup' }))).toBe('swallow');
  expect(blockJumpKey(ev({ key: 'ArrowUp' }))).toBeNull();
  expect(blockJumpKey(ev({ key: 'ArrowUp', metaKey: true, shiftKey: true }))).toBeNull();
  expect(blockJumpKey(ev({ key: 'ArrowUp', metaKey: true, altKey: true }))).toBeNull();
  expect(blockJumpKey(ev({ key: 'ArrowUp', metaKey: true, isComposing: true }))).toBeNull();
});

test('⌘F opens Find in the terminal; its other events are swallowed, other keys are not it', () => {
  expect(terminalFindKey(ev({ key: 'f', metaKey: true }))).toBe('find');
  expect(terminalFindKey(ev({ key: 'f', metaKey: true, type: 'keyup' }))).toBe('swallow');
  // ⌥⌘F, ⇧⌘F, ⌃⌘F and Ctrl+F (^F, forward a character in the shell) stay with xterm and the program.
  expect(terminalFindKey(ev({ key: 'f', metaKey: true, altKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'F', metaKey: true, shiftKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'f', metaKey: true, ctrlKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'f', ctrlKey: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'f', metaKey: true, isComposing: true }))).toBeNull();
  expect(terminalFindKey(ev({ key: 'g', metaKey: true }))).toBeNull();
});
