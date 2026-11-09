// Session panel: switch model and mode, run quick actions by typing Claude Code's own commands into the
// session — only while Claude waits at its prompt — and open the panel from the palette and menus.
import type { TerminalInfo } from '@shared/protocol';
import { SETTINGS_FIELDS, type ClaudeModel } from '@shared/settings';
import { cleanLine } from '@shared/clean-text';
import { t } from './i18n/en';
import { useApp } from './store';
import { remoteAvailability, type RemoteAvailability } from './remote';
import { enterWhenSettled } from './task-session';
import { focusTerminal } from './terminal/focus';
import { dropHeld, hasDraft, holdInput } from './terminal/drafts';

/** The same list as Settings › Claude › Model. */
export const PANEL_MODELS = (SETTINGS_FIELDS.claudeModel as { values: readonly ClaudeModel[] }).values;

/** Shift+Tab (CSI Z): Claude Code's next permission mode. */
export const NEXT_MODE_KEYS = '\x1b[Z';

export function modelCommand(model: ClaudeModel): string {
  return `/model ${model}`;
}

/** Which of the panel's models the status line's name is ("Opus 5.5" → opus); null when it can't tell. */
export function modelOf(display: string | null | undefined): ClaudeModel | null {
  const m = /\b(opus|sonnet|haiku)\b/i.exec((display ?? '').replace(/[-_]/g, ' '));
  return m ? (m[1]!.toLowerCase() as ClaudeModel) : null;
}

export type PanelAvailability = RemoteAvailability | 'draft';

/** Terminals with a panel command typed and its Enter not sent yet. */
const pending = new Set<string>();

/**
 * The Enter of that terminal's last command went (or will never go): tests and enterWhenSettled's callback. Input held
 * meanwhile went after that Enter; if the Enter never went (the terminal closed), it goes with it.
 */
export function settlePending(id: string): void {
  pending.delete(id);
  dropHeld(id);
}

/**
 * Next mode (Shift+Tab, no Enter): the rule of Continue on Phone and of sending a review — Claude's prompt free (done,
 * idle, error, or the idle notice of a finished turn) with Claude in front; a permission or question dialog ('waiting')
 * would take the keys as an answer. Also busy: a compaction running, or a command of the panel still waiting for its
 * Enter. A draft is no hazard here: nothing sends it.
 */
export function modeAvailability(term: TerminalInfo | undefined): RemoteAvailability {
  const a = remoteAvailability(term);
  if (a !== 'ok') return a;
  return term!.session!.compacting || pending.has(term!.id) ? 'busy' : 'ok';
}

/**
 * The actions that type a command and its Enter (model, Compact, Clear): the rule of Next mode, then 'draft' —
 * something typed in the prompt and not sent (drafts.ts) would be sent along with the command.
 */
export function panelAvailability(term: TerminalInfo | undefined): PanelAvailability {
  const a = modeAvailability(term);
  if (a !== 'ok') return a;
  return hasDraft(term!.id) ? 'draft' : 'ok';
}

/** Why a typing action is disabled (tooltip, toast), or null: one reason for the whole panel. */
export function panelReason(a: PanelAvailability): string | null {
  switch (a) {
    case 'ok': return null;
    case 'waiting': return t.panel.answerFirst;
    case 'draft': return t.panel.draft;
    case 'paused': return t.limit.remote;
    default: return t.panel.unavailable;
  }
}

/** Checks the session can take keys now (by `rule`); otherwise says why. */
function ready(id: string, rule: (term: TerminalInfo | undefined) => PanelAvailability = panelAvailability): boolean {
  const st = useApp.getState();
  const why = panelReason(rule(st.terminals.find((x) => x.id === id)));
  if (why) { st.showToast(why); return false; }
  return true;
}

/** The panel closes and the keyboard goes to the terminal, where Claude Code answers the command. */
function handBack(id: string): void {
  if (useApp.getState().sessionPanel === id) useApp.getState().setSessionPanel(null);
  setTimeout(() => focusTerminal(id), 0);
}

/**
 * Types a slash command as keystrokes (printable characters only), then its Enter as a separate write once the terminal
 * has settled (task-session.ts: an Enter in the same read can be lost). The keyboard goes to the terminal at once; what
 * the user types before the Enter is held and follows it (drafts.ts holdInput), never typed into the command.
 */
export function typeCommand(id: string, command: string): boolean {
  if (!ready(id)) return false;
  holdInput(id);
  // Straight to the terminal, not through sendInput: the panel's own command is no draft of the user's.
  window.atelier.terminals.input(id, cleanLine(command));
  pending.add(id);
  enterWhenSettled(id, () => settlePending(id));
  handBack(id);
  return true;
}

export function switchModel(id: string, model: ClaudeModel): boolean {
  if (!PANEL_MODELS.includes(model)) return false;
  return typeCommand(id, modelCommand(model));
}

export function compactSession(id: string): boolean {
  return typeCommand(id, '/compact');
}

/** After the panel's own confirmation. */
export function clearSession(id: string): boolean {
  return typeCommand(id, '/clear');
}

/** One Shift+Tab: no Enter (so a draft may stay: task → plan mode → send), no blind multi-step cycling. */
export function nextMode(id: string): boolean {
  if (!ready(id, modeAvailability)) return false;
  window.atelier.terminals.input(id, NEXT_MODE_KEYS);
  handBack(id);
  return true;
}

/**
 * From the palette and the menus: the session in front first (its bar is where the panel hangs), then the panel, after
 * the menu or palette that ran it has closed (they give focus back to where it was). Claude sessions only.
 */
export function openSessionPanel(id: string): void {
  const st = useApp.getState();
  if (!st.terminals.some((x) => x.id === id && x.session)) return;
  st.setActivity('sessions', { keepHidden: true });
  st.select(id);
  setTimeout(() => useApp.getState().setSessionPanel(id), 0);
}

/** View › Session Panel: the selected Claude session, else the last one selected; none: it says so. */
export function openSelectedSessionPanel(): void {
  const st = useApp.getState();
  const isSession = (id: string | null) => !!id && st.terminals.some((x) => x.id === id && x.session);
  const id = isSession(st.selectedId) ? st.selectedId : isSession(st.lastSession) ? st.lastSession : null;
  if (id) openSessionPanel(id); else st.showToast(t.panel.noSession);
}
