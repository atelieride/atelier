// When a paired phone is woken with a notification, and what it says. The news comes from Atelier's own attention
// trackers (a session starting to wait, finishing after the "only after working for" time, stopping with an error),
// grouped as the Mac groups its banners, in the same words; Settings › iPhone › Notifications picks the kinds, and by
// default a phone rings only while its user is away from this computer. At most one notice of each kind (waiting,
// finished, error) per session every 30 s.
import { createHash } from 'node:crypto';
import type { TerminalInfo } from '@shared/protocol';
import type { Settings } from '@shared/settings';
import { groupNotes, stateNotes } from '../attention';
import { projectIdOf } from './state';

/** What the trackers just saw: sessions that started waiting, finished (long enough), stopped with an error. */
export interface AttentionNews { waiting: TerminalInfo[]; done: TerminalInfo[]; error: TerminalInfo[] }

/** A notice's plaintext, sealed for each phone. */
export interface PushNotice {
  v: 1;
  kind: 'waiting' | 'done' | 'error';
  title: string;
  /** The project's name. */
  subtitle: string;
  body: string;
  /** The project's id and the terminal's, as the state lists them: a tap opens that session. */
  project: string;
  id: string;
  at: number;
}

export const PUSH_EVERY_MS = 30_000;
export const MAX_NOTICE_BYTES = 1024;
const MAX_TITLE = 80;
const MAX_BODY = 200;

const nameOf = (root: string): string => root.split('/').filter(Boolean).at(-1) ?? root;
/** At most `max` characters (an emoji counts once), an ellipsis when cut. */
const cut = (s: string, max: number): string => { const chars = [...s]; return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s; };

/** A collapse key per session (a newer notice about it replaces the older one), nothing of the id itself. */
export const collapseKeyOf = (id: string): string => `s${createHash('sha256').update(id, 'utf8').digest('base64url').slice(0, 22)}`;

/** The notice as it is sealed: title and body within their lengths, the whole within 1024 bytes of UTF-8. */
export function noticeJson(n: PushNotice): string {
  let title = cut(n.title, MAX_TITLE);
  let subtitle = cut(n.subtitle, MAX_TITLE);
  let body = cut(n.body, MAX_BODY);
  const json = () => JSON.stringify({ ...n, title, subtitle, body });
  // Too large still (multi-byte text): the body gives way first, then the subtitle, then the title.
  for (const shrink of [() => { body = cut(body, Math.max(1, [...body].length - 10)); }, () => { subtitle = cut(subtitle, Math.max(1, [...subtitle].length - 10)); }, () => { title = cut(title, Math.max(1, [...title].length - 10)); }]) {
    for (let i = 0; i < 40 && Buffer.byteLength(json(), 'utf8') > MAX_NOTICE_BYTES; i++) shrink();
  }
  return json();
}

export interface PushDeciderDeps {
  settings(): Settings;
  /** The user is away from this computer: idle for 2 minutes, or its screen locked. */
  away(): boolean;
  now?(): number;
}

export class PushDecider {
  /** When each session was last the subject of a notice of each kind (kind, then the session's id). */
  private last = new Map<string, number>();

  constructor(private readonly d: PushDeciderDeps) {}

  /** The notices the news is worth now (none while the user is here, unless that rule is off). */
  decide(news: AttentionNews): PushNotice[] {
    const s = this.d.settings();
    if (!s.remoteAccess || (s.remoteNotifyAway && !this.d.away())) return [];
    const now = this.d.now?.() ?? Date.now();
    for (const [key, at] of this.last) if (now - at >= PUSH_EVERY_MS) this.last.delete(key);
    // Per kind: a wait that flaps rings once, but a session finishing (or failing) right after it still says so.
    const keyOf = (kind: PushNotice['kind'], id: string) => `${kind} ${id}`;
    const fresh = (kind: PushNotice['kind']) => (t: TerminalInfo) => !this.last.has(keyOf(kind, t.id));
    const notes = stateNotes({ waiting: s.remoteNotifyWaiting, done: s.remoteNotifyDone, error: s.remoteNotifyError }, false,
      news.waiting.filter(fresh('waiting')), news.done.filter(fresh('done')), news.error.filter(fresh('error')));
    for (const n of notes) this.last.set(keyOf(n.kind as PushNotice['kind'], n.term.id), now);
    return groupNotes(notes).map((n): PushNotice => ({
      v: 1, kind: n.kind as PushNotice['kind'], title: n.title ?? n.term.title, subtitle: nameOf(n.term.projectRoot), body: n.body,
      project: projectIdOf(n.term.projectRoot), id: n.term.id, at: now
    }));
  }
}
