import type { TerminalInfo } from '@shared/protocol';
import { isShell } from '@shared/shells';
import { t } from './i18n/en';
import { useApp } from './store';
import { newTerminalIn } from './launch';
import { splitTerminals } from './palette-query';
import type { Starting } from './starting';
import { enterWhenSettled, pasteReason } from './task-session';
import { copyText } from './clipboard';
import { pasteSequence } from './terminal/paste';
import { focusTerminal, isBracketed, lastOutputAt } from './terminal/focus';
import { sendInput } from './terminal/drafts';

// A terminal's selection sent to another terminal: Run in New Terminal, or Send to
// Terminal… and the palette's send step.

/** A new terminal's shell: output quiet this long means its prompt is drawn. */
const QUIET_MS = 200;
/** A shell that never enables bracketed paste (bash 3.2): typed after this long anyway. */
const NO_BRACKETS_MS = 2500;
const READY_POLL_MS = 50;
const READY_TIMEOUT_MS = 10_000;

/** A destination in the send step: plain terminals first (their program as the hint), then Claude sessions. */
export interface SendRow { id: string; kind: 'terminal' | 'session'; label: string; hint: string; color: string; off: boolean }

/** `reason`: why a session can't take text now (Claude working or asking), or null; such sessions are greyed. */
export function sendRows(terminals: TerminalInfo[], starting: Starting, reason: (id: string) => string | null): SendRow[] {
  const { sessions, plain } = splitTerminals(terminals, starting);
  return [
    ...plain.map((x): SendRow => ({ id: x.id, kind: 'terminal', label: x.title, hint: x.foreground.replace(/^-/, '').split('/').at(-1) ?? '', color: x.color, off: false })),
    ...sessions.map((x): SendRow => {
      const why = reason(x.id);
      return { id: x.id, kind: 'session', label: x.title, hint: why ?? '', color: x.color, off: why !== null };
    })
  ];
}

/**
 * Why the text can't go to that terminal now, or null: it closed; a session not waiting for input (the Send Review
 * rule); several lines typed (not run) where there is no bracketed paste, so every newline would be an Enter.
 */
export function sendBlocked(o: { term: TerminalInfo | undefined; bracketed: boolean; sessionReason: string | null }, text: string, run: boolean): string | null {
  if (!o.term) return t.send.closed;
  if (o.sessionReason) return o.sessionReason;
  if (!o.bracketed && !run && text.includes('\n')) return t.send.linesWouldRun;
  return null;
}

/** A new terminal can take the text: listed, its shell in front, printed and quiet, bracketed paste on (or long enough). */
export function shellReady(o: { listed: boolean; foreground: string; bracketed: boolean; lastOutput: number; started: number; now: number }): boolean {
  if (!o.listed || !isShell(o.foreground) || o.lastOutput === 0 || o.now - o.lastOutput < QUIET_MS) return false;
  return o.bracketed || o.now - o.started >= NO_BRACKETS_MS;
}

/** One paste (bracketed when the program asked for it), in pieces under the input limit; `run`: Enter once it settles. */
export function typeInto(id: string, text: string, run: boolean): void {
  for (const part of pasteSequence(text, isBracketed(id), 256 * 1024)) sendInput(id, part);
  if (run) enterWhenSettled(id);
}

/** Send to…: types the text into that terminal (`run`: and presses Enter), then selects it with the keyboard. */
export function sendTextTo(id: string, text: string, run: boolean): void {
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === id);
  const why = sendBlocked({ term, bracketed: isBracketed(id), sessionReason: term?.session ? pasteReason(id) : null }, text, run);
  if (why) { st.showToast(why, { label: t.send.copyText, run: () => void copyText(text) }); return; }
  typeInto(id, text, run);
  st.select(id);
  if (!run) st.showToast(t.send.typedInto(term!.title), undefined, 'info');
  // After the palette that ran it has closed (it gives focus back to where it was).
  setTimeout(() => focusTerminal(id), 0);
}

/**
 * Run in New Terminal (and the send step's New Terminal): a terminal in `cwd` (the source terminal's folder; the project
 * root without one, or when main refuses it), the text typed there once its shell shows the prompt, `run`: and Enter;
 * past 10 s nothing is typed blind, a toast offers the text instead.
 */
export async function textInNewTerminal(text: string, cwd: string | null, run: boolean): Promise<void> {
  // A folder main refuses (Claude went outside the project): its notice, then the project root; nothing at all: the text
  // stays at hand.
  const info = (cwd ? await newTerminalIn(cwd).catch(() => null) : null) ?? await newTerminalIn().catch(() => null);
  if (!info) { useApp.getState().showToast(t.send.notOpened, { label: t.send.copyText, run: () => void copyText(text) }); return; }
  const started = Date.now();
  let seen = false;
  const timer = setInterval(() => {
    const now = Date.now();
    const term = useApp.getState().terminals.find((x) => x.id === info.id);
    if (term) seen = true;
    else if (seen) { clearInterval(timer); return; }
    if (shellReady({ listed: !!term, foreground: term?.foreground ?? '', bracketed: isBracketed(info.id), lastOutput: lastOutputAt(info.id), started, now })) {
      clearInterval(timer);
      const why = sendBlocked({ term, bracketed: isBracketed(info.id), sessionReason: null }, text, run);
      if (why) useApp.getState().showToast(why, { label: t.send.copyText, run: () => void copyText(text) });
      else typeInto(info.id, text, run);
      return;
    }
    if (now - started > READY_TIMEOUT_MS) {
      clearInterval(timer);
      useApp.getState().showToast(t.send.notReady, { label: t.send.copyText, run: () => void copyText(text) });
    }
  }, READY_POLL_MS);
}
