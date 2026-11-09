import { currentPlatform } from '@shared/platform';
import { isClaudeProcess, isEditorOrPager } from '@shared/shells';

interface KeyEventLike { type: string; key: string; code?: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }

/** The key types `letter`; on a non-Latin layout (Russian Ctrl+V types м) the physical key does, as Windows Terminal
 *  takes it. A Latin layout that moves letters (AZERTY) goes by the letter it types. */
function isLetter(e: KeyEventLike, letter: string): boolean {
  if (e.key.toLowerCase() === letter) return true;
  return e.key.length === 1 && e.key.charCodeAt(0) > 0x7f && e.code === `Key${letter.toUpperCase()}`;
}

/**
 * Claude is in front for its keys (Shift+Enter): a session terminal with no editor or pager in front (Ctrl+G opens vim;
 * the shell isn't excluded: the foreground updates every second and right after Claude starts it may still read zsh), or
 * Claude Code itself as the foreground process, session or not. Without Atelier's hooks there is no session: `claude`
 * typed in a shell profile that has no Atelier function (bash, fish, a plain zsh) or run by its path. Unlike the
 * right-click menu's check (isClaudeTerminal), tmux in front of a session keeps it: Claude inside tmux gets ESC CR too.
 */
export function claudeTakesKeys(o: { foreground: string; session: boolean }): boolean {
  if (isClaudeProcess(o.foreground)) return true;
  return o.session && !isEditorOrPager(o.foreground);
}

/**
 * Keys the terminal handles itself instead of xterm. Shift+Enter inserts a newline in Claude Code: it sends ESC + Enter,
 * the sequence that Claude Code's /terminal-setup configures in VS Code and Zed. Only where Claude runs: in a shell or in
 * vim ESC + Enter would do something else (in vim it leaves insert mode).
 * ⌘← / ⌘→ go to the start / end of the line as in every macOS text field: xterm.js sends nothing for them, so they
 * become Home / End (ESC O H / ESC O F in application cursor mode, as xterm's own Home key does). Shells, Claude Code,
 * vim and less all understand Home / End.
 * null = xterm decides; { send: null } = xterm must do nothing (keypress and keyup of the same key).
 */
export function keyOverride(inClaude: boolean, e: KeyEventLike, appCursor = false): { send: string | null } | null {
  if (e.isComposing) return null;
  if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (e.type !== 'keydown') return { send: null };
    const home = e.key === 'ArrowLeft';
    return { send: appCursor ? (home ? '\x1bOH' : '\x1bOF') : (home ? '\x1b[H' : '\x1b[F') };
  }
  if (!inClaude || e.key !== 'Enter' || !e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return null;
  return { send: e.type === 'keydown' ? '\x1b\r' : null };
}

/**
 * ⌘↑ / ⌘↓: previous / next command of the command blocks. xterm.js sends nothing for them; the caller
 * decides whether the terminal has blocks to jump between. 'swallow': the same keys' other events.
 */
export function blockJumpKey(e: KeyEventLike): 'prev' | 'next' | 'swallow' | null {
  // Windows has no ⌘: Ctrl+↑ / Ctrl+↓ jump between commands.
  const mod = currentPlatform() === 'win32' ? e.ctrlKey && !e.metaKey : e.metaKey && !e.ctrlKey;
  if (e.isComposing || !mod || e.shiftKey || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return null;
  if (e.type !== 'keydown') return 'swallow';
  return e.key === 'ArrowUp' ? 'prev' : 'next';
}

/**
 * Find in the terminal: ⌘F on macOS; on Windows Ctrl+Shift+F (the Windows keymap's
 * terminal-first rule: Ctrl+F stays ^F for the program). 'swallow': the same keys' other events.
 */
export function terminalFindKey(e: KeyEventLike): 'find' | 'swallow' | null {
  if (e.isComposing || e.altKey) return null;
  const win = currentPlatform() === 'win32';
  const on = win ? e.ctrlKey && e.shiftKey && !e.metaKey && isLetter(e, 'f') : e.metaKey && !e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'f';
  if (!on) return null;
  return e.type === 'keydown' ? 'find' : 'swallow';
}

/**
 * Windows: copy as Windows Terminal does — Ctrl+C copies the selection when there is
 * one (else it stays ^C for the program), Ctrl+Shift+C always copies. 'swallow': the same keys' other events. macOS:
 * ⌘C is the Edit menu's.
 */
export function copyKey(e: KeyEventLike, hasSelection: boolean): 'copy' | 'swallow' | null {
  if (currentPlatform() !== 'win32' || e.isComposing || !e.ctrlKey || e.altKey || e.metaKey || !isLetter(e, 'c')) return null;
  if (!e.shiftKey && !hasSelection) return null;
  return e.type === 'keydown' ? 'copy' : 'swallow';
}

/**
 * Windows: paste as Windows Terminal does — Ctrl+V and Ctrl+Shift+V paste, never ^V for
 * the program. 'paste': xterm must leave the keydown to the browser, whose paste event goes through the terminal's paste
 * filter (TerminalView); 'swallow': the same keys' other events. macOS: ⌘V is the Edit menu's, Ctrl+V stays ^V.
 */
export function pasteKey(e: KeyEventLike): 'paste' | 'swallow' | null {
  if (currentPlatform() !== 'win32' || e.isComposing || !e.ctrlKey || e.altKey || e.metaKey || !isLetter(e, 'v')) return null;
  return e.type === 'keydown' ? 'paste' : 'swallow';
}
