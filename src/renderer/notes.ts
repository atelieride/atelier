// Notification center entries of each project, saved in localStorage like the pins.
import { noteText, parseNotes, reasonLabel, type NoteEntry, type StateNoteKind } from '@shared/notifications';
import { t } from './i18n/en';

export const KEY = 'atelier.notifications';
/** Projects come and go: the least recently changed ones are forgotten past this many. */
const MAX_PROJECTS = 50;

function readAll(): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

export function loadNotes(root: string): NoteEntry[] {
  return parseNotes(readAll()[root]);
}

export function saveNotes(root: string, list: NoteEntry[]): void {
  try {
    const rest = Object.entries(readAll()).filter(([r]) => r !== root);
    if (list.length) rest.push([root, list]);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(rest.slice(-MAX_PROJECTS))));
  } catch { /* not saved: stays for this session */ }
}

/**
 * Under an entry's title: its kind and the activity of that moment ("waiting: " is not said twice); a group's names,
 * after the reason they stopped for when they share one.
 */
export function noteDetail(e: NoteEntry, kinds: Record<StateNoteKind, string>): string {
  if (e.kind === 'trigger') return e.activity ? `${e.sessions[0]!.title} · ${e.activity}` : e.sessions[0]!.title;
  if (e.kind === 'container') {
    const why = t.notes.container(e.container?.reason ?? 'crash', e.container?.exitCode ?? null);
    return e.activity ? `${why} · ${e.activity}` : why;
  }
  if (e.kind === 'job') return e.activity ? `${t.notes.jobFailed} · ${e.activity}` : t.notes.jobFailed;
  if (e.sessions.length > 1) {
    const names = e.sessions.map((s) => s.title).join(', ');
    return e.kind === 'error' && e.activity && e.activity !== 'error' ? `${reasonLabel(e.activity)} · ${names}` : names;
  }
  return noteText(e.kind as StateNoteKind, e.activity, kinds, e.wait);
}

/** An entry's title: the session's name, "N sessions finished/stopped" for a group, "Trigger: <rule>" for a match. */
export function noteTitle(e: NoteEntry, group: (n: number, kind: StateNoteKind) => string, trigger: (rule: string) => string): string {
  if (e.kind === 'trigger') return trigger(e.trigger ?? '');
  return e.sessions.length > 1 ? group(e.sessions.length, e.kind as StateNoteKind) : e.sessions[0]!.title;
}

/** The session you are looking at right now (its entries become read), or null. */
export function viewingNow(selectedId: string | null, activeTab: string, focused: boolean, covered: boolean): string | null {
  return focused && !covered && activeTab === 'term' ? selectedId : null;
}
