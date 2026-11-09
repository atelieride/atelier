import { describe, expect, test } from 'vitest';
import type { SignalBookView, SignalEntry, SignalKind } from '@shared/claude-signals';
import { compatStatus, copyText, entryLine, entryParts } from './claude-signals-view';

// Saturday 31 Oct 2026, local times (the row shows the local clock; the copy an ISO date).
const at = (h: number, m: number) => new Date(2026, 9, 31, h, m).getTime();
const entry = (o: Partial<SignalEntry> = {}): SignalEntry => ({
  kind: 'notification', event: 'Notification', value: 'quota_new_thing', version: '2.1.320', first: at(13, 40), last: at(14, 2), count: 3, ...o
});
const book = (entries: SignalEntry[], lastVersion: string | null = '2.1.320'): SignalBookView => ({ lastVersion, since: at(9, 0), entries });

describe('compatStatus (the row)', () => {
  test('nothing noted: everything from the last Claude Code version is recognized', () => {
    expect(compatStatus(book([], '2.1.316'), true)).toEqual({ text: 'Everything from Claude Code 2.1.316 is recognized.', count: 0, disabled: false });
  });

  test('nothing noted and no version seen yet, or no book yet: without a version', () => {
    expect(compatStatus(book([], null), true)).toEqual({ text: 'Everything Claude Code sends is recognized.', count: 0, disabled: false });
    expect(compatStatus(null, true)).toEqual({ text: 'Everything Claude Code sends is recognized.', count: 0, disabled: false });
  });

  test('N entries: how many values Atelier does not recognize yet', () => {
    expect(compatStatus(book([entry()]), true)).toEqual({ text: "1 value Atelier doesn't recognize yet", count: 1, disabled: false });
    const three = [entry(), entry({ value: 'other_thing' }), entry({ kind: 'event', event: 'BrandNewHook', value: 'BrandNewHook' })];
    expect(compatStatus(book(three), true)).toEqual({ text: "3 values Atelier doesn't recognize yet", count: 3, disabled: false });
  });

  test('an atelierd without the notebook: disabled, a restart is needed (whatever book is held)', () => {
    const off = { text: 'Needs a restart of atelierd (File › Restart atelierd).', count: 0, disabled: true };
    expect(compatStatus(null, false)).toEqual(off);
    expect(compatStatus(book([entry()]), false)).toEqual(off);
  });
});

describe('entryLine', () => {
  test('event · kind in words · value · version · count× · last HH:MM', () => {
    expect(entryLine(entry())).toBe('Notification · notification type · quota_new_thing · 2.1.320 · 3× · last 14:02');
  });

  test('a status-line finding has no event; a hook from an unknown version says so', () => {
    expect(entryLine(entry({ kind: 'status', event: null, value: 'rate_limits.five_hour', version: null, count: 1, last: at(9, 5) })))
      .toBe('— · status line · rate_limits.five_hour · unknown version · 1× · last 09:05');
  });

  test('every kind reads in words (the event name already says where)', () => {
    const words: Record<SignalKind, string> = {
      field: 'missing field', event: 'unknown event', notification: 'notification type', 'stop-error': 'stop error',
      'session-source': 'session source', 'permission-mode': 'permission mode', status: 'status line'
    };
    for (const [kind, w] of Object.entries(words)) expect(entryParts(entry({ kind: kind as SignalKind }))[1]).toBe(w);
  });

  test('the parts the row lays out are the line, the value third', () => {
    const parts = entryParts(entry());
    expect(parts.join(' · ')).toBe(entryLine(entry()));
    expect(parts[2]).toBe('quota_new_thing');
  });
});

describe('copyText (for a bug report)', () => {
  test('the Atelier and Claude Code versions, then one line per entry with the ISO date of its last time', () => {
    const e2 = entry({ kind: 'stop-error', event: 'StopFailure', value: '<other>', version: null, count: 1, last: at(14, 30) });
    expect(copyText(book([entry(), e2]), '0.9.0-beta.4')).toBe([
      'Atelier 0.9.0-beta.4',
      'Claude Code 2.1.320',
      `Notification · notification type · quota_new_thing · 2.1.320 · 3× · last ${new Date(at(14, 2)).toISOString()}`,
      `StopFailure · stop error · <other> · unknown version · 1× · last ${new Date(at(14, 30)).toISOString()}`
    ].join('\n'));
  });

  test('no Claude Code version seen: unknown; no entries: the versions alone', () => {
    expect(copyText(book([], null), '0.9.0')).toBe('Atelier 0.9.0\nClaude Code unknown');
  });
});
