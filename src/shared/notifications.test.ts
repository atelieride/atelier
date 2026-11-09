import { expect, test } from 'vitest';
import { MAX_NOTES, addNotes, containerNote, jobNote, redisSubject, markAllRead, markEntryRead, markSessionSeen, noteDays, noteText, parseNotes, pruneUnseen, reasonLabel, triggerNote, unreadNotes, type NoteEntry } from './notifications';

test('trigger entries: the rule and the line, one terminal, unread unless you are looking at it', () => {
  const term = { id: 't1', title: 'api tests', color: '#8B5CF6' };
  const n = triggerNote(term, 'tests failed', '3 tests failed', 5, 'id1', null);
  expect(n).toEqual({ id: 'id1', at: 5, kind: 'trigger', sessions: [term], activity: '3 tests failed', unseen: ['t1'], trigger: 'tests failed' });
  expect(triggerNote(term, 'r', 'l', 5, 'id2', 't1').unseen).toEqual([]);
  // A very long line is cut like any activity.
  expect(triggerNote(term, 'r', 'x'.repeat(5000), 5, 'id3', null).activity!.length).toBeLessThanOrEqual(200);
  // Saved and loaded back as they are; without its rule a trigger entry is dropped.
  expect(parseNotes([n])).toEqual([n]);
  expect(parseNotes([{ ...n, trigger: undefined }])).toEqual([]);
  expect(parseNotes([{ ...n, trigger: 7 }])).toEqual([]);
  // The rule only belongs to trigger entries.
  expect(parseNotes([{ ...n, kind: 'done' }])[0]).not.toHaveProperty('trigger');
});

const e = (id: string, at: number, sessions: string[] = ['s1'], unseen = sessions, kind: NoteEntry['kind'] = 'done'): NoteEntry => ({
  id, at, kind, sessions: sessions.map((s) => ({ id: s, title: s.toUpperCase(), color: '#8B5CF6' })), activity: null, unseen
});

test('parse: keeps only well-formed entries, drops the rest; broken input is no entries', () => {
  expect(parseNotes(null)).toEqual([]);
  expect(parseNotes('nope')).toEqual([]);
  expect(parseNotes({})).toEqual([]);
  const good = e('a', 1);
  expect(parseNotes([good, { ...good, id: 7 }, { ...good, kind: 'party' }, { ...good, sessions: [] }, { ...good, at: 'x' }, null])).toEqual([good]);
  // Unseen ids must belong to the entry's sessions; activity is a string or null; long text is clipped.
  const odd = { ...e('b', 2, ['s1', 's2'], ['s2', 'zz']), activity: 'x'.repeat(500) };
  const [p] = parseNotes([odd]);
  expect(p!.unseen).toEqual(['s2']);
  expect(p!.activity!.length).toBeLessThanOrEqual(200);
  expect(parseNotes([{ ...good, activity: 3 }])[0]!.activity).toBeNull();
});

test('parse: at most MAX_NOTES, newest first', () => {
  const many = Array.from({ length: MAX_NOTES + 20 }, (_, i) => e(`n${i}`, i));
  const out = parseNotes(many);
  expect(out).toHaveLength(MAX_NOTES);
  expect(out[0]!.id).toBe(`n${MAX_NOTES + 19}`);
});

test('add: newest first, no duplicate ids, capped', () => {
  const list = addNotes([e('a', 1)], [e('b', 3), e('c', 2), e('a', 1)]);
  expect(list.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  const full = Array.from({ length: MAX_NOTES }, (_, i) => e(`n${i}`, i));
  expect(addNotes(full, [e('new', 10_000)])).toHaveLength(MAX_NOTES);
  expect(addNotes(full, [e('new', 10_000)])[0]!.id).toBe('new');
});

test('read rules: viewing a session reads it in every entry; an entry is unread while any of its sessions is unseen', () => {
  const list = [e('g', 3, ['a', 'b', 'c']), e('one', 2, ['a']), e('other', 1, ['z'])];
  expect(unreadNotes(list)).toBe(3);
  const seenA = markSessionSeen(list, 'a');
  expect(seenA.map((x) => x.unseen)).toEqual([['b', 'c'], [], ['z']]);
  expect(unreadNotes(seenA)).toBe(2);
  // Nothing to change: the very same list (no re-render, no save).
  expect(markSessionSeen(seenA, 'a')).toBe(seenA);
  expect(unreadNotes(markEntryRead(seenA, 'g'))).toBe(1);
  expect(unreadNotes(markAllRead(seenA))).toBe(0);
  expect(markAllRead(markAllRead(seenA))).toEqual(markAllRead(seenA));
});

test('days: Today, Yesterday, then the date; newest first inside', () => {
  const now = new Date(2026, 9, 10, 15, 0).getTime();
  const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).getTime();
  const days = noteDays([e('a', at(10, 14)), e('b', at(10, 9)), e('c', at(9, 23)), e('d', at(3, 12))], now);
  expect(days.map((d) => [d.label, d.items.map((x) => x.id)])).toEqual([
    ['Today', ['a', 'b']], ['Yesterday', ['c']], ['Oct 3', ['d']]
  ]);
});

test('copy: an error reason in words, with a fallback for reasons not in the list', () => {
  expect(reasonLabel('rate_limit')).toBe('Rate limit');
  // Claude Code's StopFailure codes in plain words; the raw code stays in the tooltips.
  expect(reasonLabel('overloaded')).toBe('Overloaded');
  expect(reasonLabel('api_error')).toBe('API error');
  expect(reasonLabel('server_error')).toBe('API error');
  expect(reasonLabel('auth')).toBe('Sign-in needed');
  expect(reasonLabel('authentication_failed')).toBe('Sign-in needed');
  expect(reasonLabel('oauth_org_not_allowed')).toBe('Organization not allowed');
  expect(reasonLabel('account_on_hold')).toBe('Account on hold');
  expect(reasonLabel('billing_error')).toBe('Billing issue');
  expect(reasonLabel('model_not_found')).toBe('Model not found');
  expect(reasonLabel('max_output_tokens')).toBe('Output limit reached');
  expect(reasonLabel('cloud_credential_error')).toBe('Cloud credentials error');
  expect(reasonLabel('unknown')).toBe('Unknown error');
  expect(reasonLabel('some_new-reason')).toBe('Some new reason');
  expect(reasonLabel('Overloaded')).toBe('Overloaded');
  expect(reasonLabel('error')).toBe('Error');
});

test('copy: one line for an entry or a banner — kind in sentence case, then what it was doing ("waiting" said once)', () => {
  const kinds = { waiting: 'Waiting for you', done: 'Finished', error: 'Stopped with an error' };
  expect(noteText('waiting', 'waiting: Bash npm test', kinds)).toBe('Waiting for you · Bash npm test');
  expect(noteText('waiting', 'waiting for you', kinds)).toBe('Waiting for you');
  expect(noteText('waiting', null, kinds)).toBe('Waiting for you');
  expect(noteText('error', 'rate_limit', kinds)).toBe('Stopped with an error · Rate limit');
  expect(noteText('error', 'error', kinds)).toBe('Stopped with an error');
  expect(noteText('done', null, kinds)).toBe('Finished');
});

test('copy: with states2 a waiting entry says what for — a permission (with its target) or a question', () => {
  const kinds = { waiting: 'Waiting for you', done: 'Finished', error: 'Stopped with an error' };
  expect(noteText('waiting', 'waiting: Bash npm test', kinds, 'permission')).toBe('Needs permission · Bash npm test');
  expect(noteText('waiting', 'waiting for you', kinds, 'permission')).toBe('Needs permission');
  expect(noteText('waiting', 'waiting: question', kinds, 'question')).toBe('Has a question');
  expect(noteText('waiting', 'waiting for you', kinds, 'question')).toBe('Has a question');
  // Without it (older atelierd, older entries): as before.
  expect(noteText('waiting', 'waiting: Bash npm test', kinds, undefined)).toBe('Waiting for you · Bash npm test');
});

test('parse: an entry keeps what it waited for when valid, drops anything else', () => {
  const w = { ...e('a', 1, ['s1'], ['s1'], 'waiting'), wait: 'permission' };
  expect(parseNotes([w])[0]!.wait).toBe('permission');
  expect(parseNotes([{ ...w, wait: 'question' }])[0]!.wait).toBe('question');
  expect(parseNotes([{ ...w, wait: 'input' }])[0]!.wait).toBeUndefined();
  expect(parseNotes([{ ...w, wait: 42 }])[0]!.wait).toBeUndefined();
  expect('wait' in parseNotes([e('b', 1)])[0]!).toBe(false);
});

test('parse: an id seen twice is kept once (the newest)', () => {
  expect(parseNotes([e('a', 1), e('b', 2), e('a', 3)]).map((x) => [x.id, x.at])).toEqual([['a', 3], ['b', 2]]);
});

test('add: a session asking again while its last entry is still an unread "waiting" replaces it (no flood)', () => {
  const w = (id: string, at: number, s = 's1', unseen = [s]) => ({ ...e(id, at, [s], unseen, 'waiting'), activity: `waiting: ${id}` });
  // Its previous entry (even with others' entries in between) is unread waiting: the new one takes its place.
  let list = addNotes([], [w('w1', 1)]);
  list = addNotes(list, [w('o1', 2, 's2')]);
  list = addNotes(list, [w('w2', 3)]);
  expect(list.map((x) => x.id)).toEqual(['w2', 'o1']);
  // Read, or something else happened to it in between (it finished): kept.
  expect(addNotes([w('w1', 1, 's1', [])], [w('w2', 3)]).map((x) => x.id)).toEqual(['w2', 'w1']);
  expect(addNotes([e('d', 2), w('w1', 1)], [w('w2', 3)]).map((x) => x.id)).toEqual(['w2', 'd', 'w1']);
  // One noisy session never pushes the others out of the cap.
  const others = Array.from({ length: MAX_NOTES - 1 }, (_, i) => w(`o${i}`, i, `s${i + 10}`, []));
  let noisy = addNotes([], others);
  for (let i = 0; i < 300; i++) noisy = addNotes(noisy, [w(`n${i}`, 1000 + i)]);
  expect(noisy).toHaveLength(MAX_NOTES);
  expect(noisy.filter((x) => x.sessions[0]!.id === 's1').map((x) => x.id)).toEqual(['n299']);
});

test('add: a trigger matching again while its entry for that terminal and rule is unread joins it (×N): triggers never evict the history', () => {
  const term = (id: string) => ({ id, title: id, color: '#fff' });
  const trg = (id: string, at: number, t = 't1', rule = 'tests failed', viewing: string | null = null) => triggerNote(term(t), rule, `${id} line`, at, id, viewing);
  let list = addNotes([], [trg('a', 1)]);
  list = addNotes(list, [trg('o', 2, 't2')]);
  list = addNotes(list, [trg('b', 3)]);
  list = addNotes(list, [trg('c', 4)]);
  expect(list.map((x) => [x.id, x.count ?? 1, x.activity])).toEqual([['c', 3, 'c line'], ['o', 1, 'o line']]);
  // Another rule, or the entry already read: kept apart.
  expect(addNotes([trg('a', 1)], [trg('r', 2, 't1', 'ERROR')]).map((x) => x.id)).toEqual(['r', 'a']);
  expect(addNotes(markEntryRead([trg('a', 1)], 'a'), [trg('b', 2)]).map((x) => x.id)).toEqual(['b', 'a']);
  // A flood of matches never pushes the session history out of the cap.
  const history = Array.from({ length: MAX_NOTES - 1 }, (_, i) => e(`h${i}`, i, [`s${i}`], [], 'done'));
  let flood = addNotes([], history);
  for (let i = 0; i < 300; i++) flood = addNotes(flood, [trg(`f${i}`, 1000 + i)]);
  expect(flood.filter((x) => x.kind === 'done')).toHaveLength(MAX_NOTES - 1);
  expect(flood.find((x) => x.kind === 'trigger')?.count).toBe(300);
  // The count is saved and loaded back; nonsense is dropped.
  expect(parseNotes([{ ...trg('p', 1), count: 7 }])[0]!.count).toBe(7);
  expect(parseNotes([{ ...trg('p', 1), count: -2 }])[0]!.count).toBeUndefined();
  expect(parseNotes([{ ...trg('p', 1), count: '9' }])[0]!.count).toBeUndefined();
});

test('prune: sessions that no longer exist are no longer unseen (the count never stays stale)', () => {
  const list = [e('a', 3, ['s1', 's2']), e('b', 2, ['s3']), e('c', 1, ['s1'], [])];
  const out = pruneUnseen(list, new Set(['s1']));
  expect(out.map((x) => x.unseen)).toEqual([['s1'], [], []]);
  expect(unreadNotes(out)).toBe(1);
  // Nothing to change: the same list.
  expect(pruneUnseen(out, new Set(['s1']))).toBe(out);
});

test('job entries: the queue is the subject, unread until the queue is looked at', () => {
  const n = { id: 'j1', at: 5, instance: 'tcp:6379', queue: { id: 'bullmq|bull|email-queue', name: 'email-queue', lib: 'bullmq' }, job: { id: '8812', name: 'send-receipt', reason: 'connect ECONNREFUSED' } };
  const e = jobNote(n);
  const subject = redisSubject(n.queue.id);
  expect(subject.startsWith('redis:')).toBe(true);
  expect(subject.length).toBeLessThanOrEqual(80);
  expect(e).toEqual({ id: 'j1', at: 5, kind: 'job', sessions: [{ id: subject, title: 'email-queue', color: 'redis' }], activity: 'send-receipt · connect ECONNREFUSED', unseen: [subject], job: { queue: n.queue.id, name: 'email-queue', job: '8812', lib: 'bullmq' } });
  expect(parseNotes([e])).toEqual([e]);
  expect(parseNotes([{ ...e, job: { ...e.job, queue: '' } }])).toEqual([]);
  expect(parseNotes([{ ...e, sessions: [{ id: 'redis:other', title: 'x', color: 'redis' }] }])).toEqual([]);
  expect(pruneUnseen([e], new Set())[0]!.unseen).toEqual([subject]);
  expect(markSessionSeen([e], subject)[0]!.unseen).toEqual([]);
  const again = jobNote({ ...n, id: 'j2', at: 9, job: { ...n.job, id: '8813' } });
  expect(addNotes([e], [again])).toHaveLength(1);
  expect(addNotes([e], [again])[0]).toMatchObject({ id: 'j2', count: 2 });
});

test('container entries: the container is the subject, unread until it is looked at', () => {
  const id = 'f'.repeat(64);
  const n = { id: 'n1', at: 5, container: { id, name: 'worker', project: 'acme' }, reason: 'crash' as const, exitCode: 1, line: 'Error: boom' };
  const e = containerNote(n);
  expect(e).toEqual({ id: 'n1', at: 5, kind: 'container', sessions: [{ id: `docker:${id}`, title: 'worker', color: 'docker' }], activity: 'Error: boom', unseen: [`docker:${id}`], container: { id, project: 'acme', reason: 'crash', exitCode: 1 } });
  // Saved and loaded back; a broken container is dropped.
  expect(parseNotes([e])).toEqual([e]);
  expect(parseNotes([{ ...e, container: { id: 'nope', project: null, reason: 'crash', exitCode: 1 } }])).toEqual([]);
  expect(parseNotes([{ ...e, container: { ...e.container, reason: 'meh' } }])).toEqual([]);
  // Terminals coming and going never mark it read; looking at the container does.
  expect(pruneUnseen([e], new Set(['s1']))[0]!.unseen).toEqual([`docker:${id}`]);
  expect(markSessionSeen([e], `docker:${id}`)[0]!.unseen).toEqual([]);
  // Crashing again while unread joins the entry (×N), the newest line on top.
  const again = containerNote({ ...n, id: 'n2', at: 9, line: 'Error: again' });
  const list = addNotes([e], [again]);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: 'n2', activity: 'Error: again', count: 2 });
  // Read: a new crash is a new entry.
  expect(addNotes(markAllRead([e]), [again])).toHaveLength(2);
});
