// Settings › Claude › Claude Code compatibility as the UI shows it: the status,
// one line per noted value, the text Copy puts on the clipboard. Pure. The notebook's module is backend-only for the
// website's demo: types only from it.
import type { SignalBookView, SignalEntry } from '@shared/claude-signals';
import { t } from './i18n/en';
import { clockOf } from './schedule-view';

/** The row's status: what is noted, or that atelierd needs a restart to keep a notebook (capability `signals`). */
export function compatStatus(book: SignalBookView | null, available: boolean): { text: string; count: number; disabled: boolean } {
  if (!available) return { text: t.set.compatNeedsRestart, count: 0, disabled: true };
  const count = book?.entries.length ?? 0;
  return { text: count ? t.set.compatUnknown(count) : t.set.compatAllKnown(book?.lastVersion ?? null), count, disabled: false };
}

/**
 * An entry's parts, the kind in words second, the value third (the row sets it apart); `when` writes its last time (the
 * local clock by default).
 */
export function entryParts(e: SignalEntry, when: (ms: number) => string = clockOf): string[] {
  return [e.event ?? '—', t.set.compatKind[e.kind], e.value, e.version ?? 'unknown version', `${e.count}×`, `last ${when(e.last)}`];
}

/** `Notification · notification type · quota_new_thing · 2.1.320 · 3× · last 14:02`. */
export function entryLine(e: SignalEntry, when?: (ms: number) => string): string {
  return entryParts(e, when).join(' · ');
}

const iso = (ms: number) => new Date(ms).toISOString();

/** For a bug report: the Atelier and Claude Code versions, then each entry with the full date of its last time. */
export function copyText(book: SignalBookView, appVersion: string): string {
  return [`Atelier ${appVersion}`, `Claude Code ${book.lastVersion ?? 'unknown'}`, ...book.entries.map((e) => entryLine(e, iso))].join('\n');
}
