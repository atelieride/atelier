// Continue on phone: Claude Code's own /remote-control, typed into the session's prompt.
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { t } from './i18n/en';
import { isEditorOrPager, isShell } from '@shared/shells';
import { isLimitPaused, isWaiting } from '@shared/session-view';
import { focusTerminal } from './terminal/focus';
import { sendInput } from './terminal/drafts';

const NAME_MAX = 60;

/** `/remote-control <title>`: the title as printable characters only, at most 60; with nothing left, no name. */
export function remoteCommand(title: string): string {
  // Any whitespace run (tabs, line breaks, Unicode separators) is one space; other control characters go away.
  const clean = title.replace(/\s+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  const name = Array.from(clean).slice(0, NAME_MAX).join('').trim();
  return name ? `/remote-control ${name}` : '/remote-control';
}

export type RemoteAvailability = 'ok' | 'waiting' | 'busy' | 'paused' | 'not-claude';

/**
 * Claude sessions only, and only when Claude's prompt is free: idle, done or error, with Claude in front. Waiting
 * (waitingFor permission or question; the state alone with an older atelierd) means a permission or question dialog is open (typed text and a digit or Enter would answer it); running, or an
 * editor, pager or the shell in front, means the keystrokes would go somewhere else. Paused at a usage limit: anything
 * typed would replace Claude Code's own continuation.
 */
export function remoteAvailability(term: TerminalInfo | undefined): RemoteAvailability {
  if (!term?.session) return 'not-claude';
  if (isWaiting(term.session)) return 'waiting';
  if (isLimitPaused(term.session)) return 'paused';
  // The raw state: background work leaves the prompt free (the effective state would read it as running).
  if (term.session.state === 'running' || isEditorOrPager(term.foreground) || isShell(term.foreground)) return 'busy';
  return 'ok';
}

/** Why it is not available (tooltip, palette hint, toast), or null when it is. */
export function remoteReason(a: RemoteAvailability): string | null {
  return a === 'waiting' ? t.remoteWaiting : a === 'busy' ? t.remoteBusy : a === 'paused' ? t.limit.remote : null;
}

/**
 * Selects the session and types the command, as if typed, without Enter: a draft already in the prompt would be
 * submitted with it (or run as a shell command in "!" mode). You press Enter; Claude Code shows its confirmation and QR.
 */
export function continueOnPhone(id: string): void {
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === id);
  const ok = remoteAvailability(term);
  if (ok !== 'ok') { const why = remoteReason(ok); if (why) st.showToast(why); return; }
  st.setActivity('sessions', { keepHidden: true });
  st.select(id);
  // Keystrokes, not a paste: Claude Code treats it as a command typed in its prompt.
  sendInput(id, remoteCommand(term!.title));
  st.showToast(t.remotePressEnter, undefined, 'info');
  // After the menu or palette that ran it has closed (they give focus back to where it was).
  setTimeout(() => focusTerminal(id), 0);
}
