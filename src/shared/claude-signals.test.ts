import { describe, expect, test } from 'vitest';
import { MAX_SIGNALS, noteHook, noteStatus, parseBook, recordFindings, type Finding, type SignalBookView } from './claude-signals';

const installed = new Set(['SessionStart', 'Notification', 'StopFailure', 'Stop']);
const base = { hook_event_name: 'Notification', session_id: 's1' };

describe('noteHook', () => {
  test('a fully known payload yields nothing', () => {
    expect(noteHook({ ...base, notification_type: 'quota_auto_resume_fired', permission_mode: 'plan' }, installed)).toEqual([]);
    expect(noteHook({ hook_event_name: 'StopFailure', session_id: 's', error: 'rate_limit' }, installed)).toEqual([]);
    expect(noteHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'fork' }, installed)).toEqual([]);
  });

  test('field: a missing hook_event_name or session_id is named', () => {
    expect(noteHook({ session_id: 's' }, installed)).toEqual([{ kind: 'field', event: null, value: 'hook_event_name' }]);
    expect(noteHook({ hook_event_name: 'Stop', session_id: 3 }, installed)).toEqual([{ kind: 'field', event: 'Stop', value: 'session_id' }]);
    expect(noteHook('nope', installed).map((f) => f.value)).toEqual(['hook_event_name', 'session_id']);
  });

  test('event: an event Atelier did not install', () => {
    expect(noteHook({ hook_event_name: 'TaskCreated', session_id: 's' }, installed)).toEqual([{ kind: 'event', event: 'TaskCreated', value: 'TaskCreated' }]);
  });

  test('notification, stop-error, session-source, permission-mode', () => {
    expect(noteHook({ ...base, notification_type: 'quota_new_thing' }, installed)).toEqual([{ kind: 'notification', event: 'Notification', value: 'quota_new_thing' }]);
    expect(noteHook({ hook_event_name: 'StopFailure', session_id: 's', error: 'brand_new' }, installed)).toEqual([{ kind: 'stop-error', event: 'StopFailure', value: 'brand_new' }]);
    expect(noteHook({ hook_event_name: 'SessionStart', session_id: 's', source: 'teleport' }, installed)).toEqual([{ kind: 'session-source', event: 'SessionStart', value: 'teleport' }]);
    expect(noteHook({ ...base, permission_mode: 'yolo' }, installed)).toEqual([{ kind: 'permission-mode', event: 'Notification', value: 'yolo' }]);
  });

  test('a value that is not a plain code becomes <other>', () => {
    expect(noteHook({ ...base, notification_type: 'quota new thing!' }, installed)[0]?.value).toBe('<other>');
    expect(noteHook({ ...base, notification_type: 'a'.repeat(41) }, installed)[0]?.value).toBe('<other>');
    expect(noteHook({ ...base, notification_type: 'a'.repeat(40) }, installed)[0]?.value).toBe('a'.repeat(40));
  });

  test('never carries anything else from the payload', () => {
    const secret = ['write me a poem about my bank', '/Users/me/secret-project', 'My private title'];
    const found = noteHook({ ...base, notification_type: 'novel_type', prompt: secret[0], cwd: secret[1], title: secret[2], message: secret[0], transcript_path: secret[1] }, installed);
    expect(found).toHaveLength(1);
    const json = JSON.stringify(found);
    for (const s of secret) expect(json).not.toContain(s);
  });
});

describe('noteStatus', () => {
  test('a window without numbers is named', () => {
    expect(noteStatus({ rate_limits: { five_hour: { used_percentage: 'x' }, seven_day: { used_percentage: 3, resets_at: 5 } } }))
      .toEqual([{ kind: 'status', event: null, value: 'rate_limits.five_hour' }]);
  });
  test('a broken cost is named, a good one is not', () => {
    expect(noteStatus({ cost: { total_cost_usd: 'a' } })).toEqual([{ kind: 'status', event: null, value: 'cost' }]);
    expect(noteStatus({ cost: { total_cost_usd: 1, total_lines_added: 2, total_lines_removed: 3 } })).toEqual([]);
  });
  test('no rate_limits at all (API-key accounts) yields nothing', () => {
    expect(noteStatus({ model: { display_name: 'x' } })).toEqual([]);
    expect(noteStatus(null)).toEqual([]);
  });
});

const empty = (): SignalBookView => ({ lastVersion: null, since: 1, entries: [] });
const f = (value: string, kind: Finding['kind'] = 'notification'): Finding => ({ kind, event: 'Notification', value });

describe('recordFindings', () => {
  test('adds, then merges by kind+event+value+version', () => {
    const a = recordFindings(empty(), [f('x')], '2.1.1', 100);
    expect(a.entries).toEqual([{ ...f('x'), version: '2.1.1', first: 100, last: 100, count: 1 }]);
    expect(a.since).toBe(100);
    const b = recordFindings(a, [f('x')], '2.1.1', 200);
    expect(b.entries).toEqual([{ ...f('x'), version: '2.1.1', first: 100, last: 200, count: 2 }]);
    const c = recordFindings(b, [f('x')], '2.1.2', 300);
    expect(c.entries).toHaveLength(2);
    expect(recordFindings(c, [f('x', 'stop-error')], '2.1.2', 300).entries).toHaveLength(3);
  });
  test('caps at 100, dropping the oldest last', () => {
    let b = empty();
    for (let i = 0; i < MAX_SIGNALS + 5; i++) b = recordFindings(b, [f(`v${i}`)], null, 10 + i);
    expect(b.entries).toHaveLength(MAX_SIGNALS);
    expect(b.entries.some((e) => e.value === 'v0')).toBe(false);
    expect(b.entries.some((e) => e.value === `v${MAX_SIGNALS + 4}`)).toBe(true);
  });
  test('lastVersion follows the version seen; the same object when nothing changes', () => {
    const a = empty();
    expect(recordFindings(a, [], null, 5)).toBe(a);
    const b = recordFindings(a, [], '2.1.9', 5);
    expect(b.lastVersion).toBe('2.1.9');
    expect(recordFindings(b, [], '2.1.9', 6)).toBe(b);
    expect(recordFindings(b, [], null, 6)).toBe(b);
  });
  test('lastVersion keeps the highest version seen: two Claude Codes at once (old sessions after an update) never flap it', () => {
    const a = recordFindings(empty(), [], '2.1.316', 5);
    const b = recordFindings(a, [], '2.1.320', 6);
    expect(b.lastVersion).toBe('2.1.320');
    expect(recordFindings(b, [], '2.1.316', 7)).toBe(b);
    expect(recordFindings(b, [], '2.1.320', 8)).toBe(b);
    // Numeric part by part, not text: 2.1.4 is older than 2.1.320.
    expect(recordFindings(b, [], '2.1.4', 9)).toBe(b);
    expect(recordFindings(b, [], '2.2', 9).lastVersion).toBe('2.2');
    // A lower version's findings are still noted under their own version.
    const c = recordFindings(b, [f('x')], '2.1.316', 10);
    expect(c.lastVersion).toBe('2.1.320');
    expect(c.entries[0]?.version).toBe('2.1.316');
  });
});

describe('parseBook', () => {
  test('round trips a book', () => {
    const b = recordFindings(empty(), [f('x')], '2.1.1', 100);
    expect(parseBook(JSON.parse(JSON.stringify(b)), 9)).toEqual(b);
  });
  test('anything invalid is an empty book', () => {
    for (const raw of [null, 3, 'x', [], {}, { entries: 'x', since: 1 }, { lastVersion: null, since: 1, entries: [{ kind: 'nope' }] }]) {
      expect(parseBook(raw, 9)).toEqual({ lastVersion: null, since: 9, entries: [] });
    }
  });
});
