// Ask companion: opening and closing it from the session bar's button and ⌘I (the menus and the
// palette call the same). Opening gives the keyboard to the panel's composer; closing gives it back to the terminal.
import { useApp, type AppState } from '../store';
import { focusTerminal, isBracketed } from '../terminal/focus';
import { sendInput } from '../terminal/drafts';
import { reviewPaste } from '../comments';
import { chunk } from '../mention';
import { t } from '../i18n/en';
import { askPromptReason } from './model';
import { askTarget, promptText } from './view';
import { livesElsewhere, shownIn } from './attention';

/** The terminal whose panel opens next, from a user action: its composer takes the keyboard once it is on screen. */
let focusNext: string | null = null;

/** True once for the panel just opened (a panel shown again, a tab switched back to, leaves the keyboard alone). */
export function takeAskFocus(terminalId: string): boolean {
  if (focusNext !== terminalId) return false;
  focusNext = null;
  return true;
}

/** Closes the terminal's Ask and gives the terminal the keyboard. */
export function closeAsk(terminalId: string): void {
  useApp.getState().closeAskPanel(terminalId);
  focusTerminal(terminalId);
}

/** The session bar's button: opens Ask (the composer takes the keyboard) or closes it (the terminal does). */
export function toggleAskFor(terminalId: string, o?: { catchUp?: boolean }): void {
  const st = useApp.getState();
  if (st.askOpen[terminalId]) { closeAsk(terminalId); return; }
  st.toggleAsk(terminalId, o);
  if (useApp.getState().askOpen[terminalId]) focusNext = terminalId;
}

/** The terminals whose tab is on screen in this window: the one in front, or every pane of a split. */
export function shownTerminals(st: Pick<AppState, 'split' | 'activeTab' | 'selectedId' | 'activeKey'> = useApp.getState()): Set<string> {
  return shownIn(st);
}

/**
 * The session menus, the palette and the sidebar's mark: Ask for that session, its terminal shown first,
 * opened if it was closed (an open one stays open); either way its composer has the keyboard. A session whose tab lives
 * in another window: that window comes forward (its Ask is there), nothing opens here. catchUp: and a Catch me up
 *, at once in an open panel, once its thread has loaded in one just opened.
 */
export function openAskFor(terminalId: string, o?: { catchUp?: boolean }): void {
  const st = useApp.getState();
  if (livesElsewhere(st, terminalId)) { st.select(terminalId); return; }
  if (!st.askOpen[terminalId] && !st.terminals.some((x) => x.id === terminalId && x.session)) { st.showToast(t.companion.noSession); return; }
  if (!shownTerminals().has(terminalId)) st.select(terminalId);
  if (!useApp.getState().askOpen[terminalId]) { toggleAskFor(terminalId, o); return; }
  if (o?.catchUp) useApp.getState().askCatchUp(terminalId);
  // Already open: its panel (shown again by the select, maybe) takes the keyboard once it is on screen.
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`.ask[data-terminal="${CSS.escape(terminalId)}"] .ask-comp textarea`)?.focus({ preventScroll: true }));
}

/** The palette's Catch Me Up on This Session: its Ask, and a Catch me up there. */
export function catchUpFor(terminalId: string): void {
  openAskFor(terminalId, { catchUp: true });
}

/**
 * Use as prompt: the answer, its verdict line left out, typed into the session's prompt as one bracketed
 * paste and never sent (no Enter), then the terminal has the keyboard to edit and send it. Same rule and plumbing as
 * Review's Send to session (review-send.ts); refused with its reason when Claude isn't at its prompt or the answer is
 * only its verdict. A leading `!` or `/` is neutralized (promptText).
 */
export function sendAsPrompt(terminalId: string, markdown: string): void {
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === terminalId);
  const text = promptText(markdown);
  const why = askPromptReason(term, isBracketed(terminalId), text);
  if (why) { st.showToast(why); return; }
  // In pieces under the terminal input limit: still one paste, the bytes arrive in order.
  for (const part of chunk(reviewPaste(text), 256 * 1024)) sendInput(terminalId, part);
  st.showToast(t.companion.usedAsPrompt(term!.title), undefined, 'info');
  focusTerminal(terminalId);
}

/**
 * ⌘I (the ask-session command; Ctrl+Shift+I on Windows): toggles Ask for the focused session, shown first when it isn't
 * on screen.
 */
export function askSelected(): void {
  const st = useApp.getState();
  const target = askTarget({
    selectedId: st.selectedId, lastSession: st.lastSession, open: new Set(Object.keys(st.askOpen)),
    sessions: new Set(st.terminals.filter((x) => x.session).map((x) => x.id)), shown: shownTerminals()
  });
  if (!target) { st.showToast(t.companion.noSession); return; }
  if (target.show) st.select(target.id);
  if (target.toggle) toggleAskFor(target.id);
}
