// The right-click in a terminal: Atelier's menu, unless the program in front captures the mouse (tmux, vim with
// mouse=a…): then the click is its own, and two menus would overlap. ⇧ always gives Atelier's menu. Claude Code has no
// right-click menu, so its sessions keep Atelier's (Claude runs under its version as the process name).

import { isClaudeProcess, isEditorOrPager } from '@shared/shells';

/**
 * Claude is in front: its version as the process name, or a session terminal (Claude starts through the shell's claude
 * function, so the foreground can read zsh) with no other program in front (not the $EDITOR Claude opened with Ctrl+G,
 * not tmux).
 */
export function isClaudeTerminal(o: { foreground: string; session?: boolean }): boolean {
  if (isClaudeProcess(o.foreground)) return true;
  const name = o.foreground.replace(/^-/, '').split('/').at(-1) ?? '';
  return !!o.session && !isEditorOrPager(o.foreground) && name !== 'tmux';
}

export function atelierMenuOnRightClick(o: { mouseTracking: boolean; foreground: string; shiftKey: boolean; session?: boolean }): boolean {
  return o.shiftKey || !o.mouseTracking || isClaudeTerminal(o);
}

/**
 * F10 in a focused terminal on Windows: the program's when it runs full screen (htop, mc: the alternate screen or mouse
 * tracking on), the window menu's otherwise. Claude Code has no use for F10: its sessions keep the menu's.
 */
export function programTakesF10(o: { alternate: boolean; mouseTracking: boolean; foreground: string; session?: boolean }): boolean {
  return (o.alternate || o.mouseTracking) && !isClaudeTerminal(o);
}
