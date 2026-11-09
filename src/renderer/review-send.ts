// Send to session: a session's comment drafts typed into its prompt as one bracketed paste, no Enter.
import { useApp } from './store';
import { t } from './i18n/en';
import { composeReview, isPending, reviewPaste, sendAvailability } from './comments';
import { remoteReason } from './remote';
import { chunk } from './mention';
import { focusTerminal, isBracketed } from './terminal/focus';
import { sendInput } from './terminal/drafts';

/** Drafts waiting for a session (the "Pending review" count). */
export function pendingFor(id: string): number {
  return useApp.getState().comments.filter((c) => isPending(c, id)).length;
}

/** Why the session's review can't be sent right now (tooltip, palette hint, toast), or null when it can. */
export function sendReason(id: string): string | null {
  const st = useApp.getState();
  const term = st.terminals.find((x) => x.id === id);
  if (!term?.session) return t.comments.closed;
  if (!pendingFor(id)) return t.comments.noneFor(term.title);
  return remoteReason(sendAvailability(term, isBracketed(id)));
}

/**
 * Types the session's drafts into its prompt, selects it and gives it the keyboard; no Enter: you read the block and
 * send it. The drafts are cleared, and the toast's Undo brings them back (the typed text stays in the prompt).
 */
export function sendReview(id: string): void {
  const st = useApp.getState();
  const why = sendReason(id);
  if (why) { st.showToast(why); return; }
  const term = st.terminals.find((x) => x.id === id)!;
  const list = st.comments.filter((c) => isPending(c, id));
  const root = st.project?.root ?? '/';
  const text = reviewPaste(composeReview(list, { cwd: term.session?.cwd ?? term.cwd ?? root, root, realRoot: st.project?.realRoot ?? root }));
  // In pieces under the terminal input limit: still one paste, the bytes arrive in order.
  for (const part of chunk(text, 256 * 1024)) sendInput(id, part);
  const removed = st.removeComments(list.map((c) => c.id));
  st.setActivity('sessions', { keepHidden: true });
  st.select(id);
  st.showToast(t.comments.sent(removed.length, term.title), { label: t.comments.undo, run: () => useApp.getState().restoreComments(removed) }, 'info');
  // After the menu or palette that ran it has closed (they give focus back to where it was).
  setTimeout(() => focusTerminal(id), 0);
}
