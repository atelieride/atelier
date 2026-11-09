// Session name sync: one name per session, owned by Claude. A name given in Atelier is pending until
// atelierd hands it to Claude in its reply to the next UserPromptSubmit or SessionStart hook (hookSpecificOutput
// .sessionTitle) and Claude reports it back. Pure: atelierd keeps the state per terminal.

/**
 * pending = given in Atelier, not yet handed to Claude; sent = handed over, Claude's verdict not seen yet; synced =
 * Claude has it (or adopted from Claude); kept = Claude didn't take it, so it stays an Atelier-only name.
 */
export type NameSync = 'pending' | 'sent' | 'synced' | 'kept';
/** before: while sent, Claude's custom title when the name was handed over (its next report is a verdict if it differs). */
export interface NameState { name: string | null; sync: NameSync; before?: string | null }
export const NO_NAME: NameState = { name: null, sync: 'synced' };

/** What atelierd prints back to Claude Code from the hook bridge. */
export interface NameReply { hookSpecificOutput: { hookEventName: 'UserPromptSubmit' | 'SessionStart'; sessionTitle: string } }

const NAME_MAX = 200;
// Control characters, format characters (zero-width, bidi overrides, BOM) and line/paragraph separators.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// The only hooks that report Claude's custom title (`session_title`) and accept a `sessionTitle` back.
const TITLE_EVENTS = new Set(['UserPromptSubmit', 'SessionStart']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A name given in Atelier: one line, no invisible characters, at most 200 characters; empty = no name. */
export function renamed(name: string | null | undefined): NameState {
  const clean = [...(name ?? '').slice(0, 4096).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  return clean ? { name: clean, sync: 'pending' } : NO_NAME;
}

/** A hook event: the next state, and the reply to print back to Claude (null = print nothing). */
export function onNameHook(s: NameState, payload: unknown): { state: NameState; reply: NameReply | null } {
  const same = { state: s, reply: null };
  if (!isObj(payload) || !s.name) return same;
  const event = str(payload.hook_event_name);
  if (!event || !TITLE_EVENTS.has(event)) return same;
  const claude = str(payload.session_title);
  switch (s.sync) {
    case 'pending':
      if (claude === s.name) return { state: { name: s.name, sync: 'synced' }, reply: null };
      return { state: { name: s.name, sync: 'sent', before: claude }, reply: { hookSpecificOutput: { hookEventName: event as NameReply['hookSpecificOutput']['hookEventName'], sessionTitle: s.name } } };
    case 'sent':
      // Claude's verdict, final either way: one attempt per name. The name it had before (the reply lost or ignored),
      // or none, means it didn't take it.
      if (claude && claude !== (s.before ?? null)) return { state: { name: claude, sync: 'synced' }, reply: null };
      return { state: { name: s.name, sync: 'kept' }, reply: null };
    default:
      // A rename inside Claude (or another client). No custom title (a new conversation after /clear) changes nothing.
      if (claude && claude !== s.name) return { state: { name: claude, sync: 'synced' }, reply: null };
      return same;
  }
}

/**
 * The terminal session's status line: right after a send, Claude showing the name confirms it. Nothing else is a
 * verdict: `session_name` is the custom title or the AI title, and a render may predate the send.
 */
export function onNameStatus(s: NameState, payload: unknown, sessionId: string): NameState {
  if (s.sync !== 'sent' || !isObj(payload) || payload.session_id !== sessionId || str(payload.session_name) !== s.name) return s;
  return { name: s.name, sync: 'synced' };
}

/** What the app shows about the name (TerminalInfo.nameSync): only for a named terminal with a Claude session. */
export function visibleSync(s: NameState, hasSession: boolean): 'pending' | 'kept' | undefined {
  if (!s.name || !hasSession) return undefined;
  return s.sync === 'pending' || s.sync === 'sent' ? 'pending' : s.sync === 'kept' ? 'kept' : undefined;
}

/**
 * A resumed terminal's name, as saved and not cleaned again (an adopted Claude name must stay exact). A send whose
 * verdict was lost in the restart is pending again; a name with no state (saved before name sync) is Atelier-only.
 */
export function resumedName(r: { name?: string | null; nameSync?: NameSync }): NameState {
  if (!r.name) return NO_NAME;
  return { name: r.name, sync: r.nameSync === 'sent' ? 'pending' : r.nameSync ?? 'kept' };
}

/**
 * A conversation from Claude's history resumed in a new terminal: with name sync (capability 'names') its title is
 * only a label, since Claude reports its own name at once and a name would be pushed as a custom title; an older
 * atelierd gets it as the name, as before.
 */
export function historyResumeTitle(title: string, names: boolean): { name: string } | { label: string } {
  const t = title.slice(0, 80);
  return names ? { label: t } : { name: t };
}

/**
 * The displayed title: a name not synced yet; otherwise Claude's live name, then the name, the label (a resumed
 * session's last title), the first prompt, the fallback. Without a Claude session: name, label, fallback.
 */
export function terminalTitle(s: NameState, label: string | null, session: { title: string | null; autoTitle?: string | null } | null, fallback: () => string): string {
  if (!session) return s.name ?? label ?? fallback();
  if (s.name && s.sync !== 'synced') return s.name;
  return session.title ?? s.name ?? label ?? session.autoTitle ?? fallback();
}
