// Under an idle or finished session: when its last message was. Pure.
import type { SessionInfo } from '@shared/session';
import { isWaiting } from '@shared/session-view';
import { MONTHS, relativeTime } from './history';
import { t } from './i18n/en';

const two = (n: number) => String(n).padStart(2, '0');

/** "Oct 14, 14:32" ("Dec 30, 2025, 23:59" in another year). */
function dateTime(at: number, now: number): string {
  const d = new Date(at);
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * "28m ago" (tooltip: the full date and time) for a done or idle session that knows its last message time; null for a
 * busy, waiting or failed session, a compacting one, or with no time (a new session, an atelierd from an earlier build).
 */
export function lastMessageLine(s: SessionInfo, now: number): { text: string; tip: string } | null {
  if ((s.state !== 'done' && s.state !== 'idle') || s.lastMessageAt == null || s.compacting || isWaiting(s)) return null;
  return { text: relativeTime(s.lastMessageAt, now), tip: t.lastMessageTip(dateTime(s.lastMessageAt, now)) };
}
