import { expect, test } from 'vitest';
import type { BackgroundWork } from '@shared/background';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
// The sidebar's own functions, read here only: main computes the same with its own code.
import { inboxSection } from '../../renderer/inbox';
import { sessionSubtitle } from '../../renderer/selectors';
import { t as words } from '../../renderer/i18n/en';
import { MAX_DETAIL, WaitBook, anyWait, detailOf, isPlanApproval, permissionOf, sectionOf, waitOf } from './rows';

const term = (session: SessionInfo | null, work?: BackgroundWork): TerminalInfo => ({
  id: 't1', projectRoot: '/p', cwd: '/p', title: 'T', name: null, color: '#B794F6', foreground: 'claude', createdAt: 1, session, ...(work ? { work } : {})
});
const session = (o: Partial<SessionInfo>): SessionInfo => ({ sessionId: 's', state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 5, ...o });
const work = (counting: boolean, label: string | null): BackgroundWork => ({
  counting, agents: 0, shells: 1, monitors: 0, other: 0, idle: 0, items: label === null ? [] : [{ kind: 'shell', label, counted: true }]
} as unknown as BackgroundWork);

const NOW = new Date(2026, 10, 23, 14, 0).getTime();
const HOUR = 3_600_000;
const STATES = ['idle', 'running', 'waiting', 'done', 'error'] as const;
const WAITS = [null, 'permission', 'question', 'input'] as const;
const ACTIVITIES = [null, 'Edit README.md', 'waiting: Bash npm test', 'waiting: plan approval', 'waiting for you'];
const REASONS = [null, 'rate_limit', 'overloaded', 'some_new_code'];
const PAUSES = [
  undefined,
  { since: NOW - HOUR, resetsAt: null },
  { since: NOW - HOUR, resetsAt: NOW + 2 * HOUR },
  { since: NOW - HOUR, resetsAt: NOW + 12 * HOUR },
  { since: NOW - HOUR, resetsAt: NOW + 72 * HOUR },
  { since: NOW - HOUR, resetsAt: NOW - HOUR },
  { since: NOW - HOUR, resetsAt: NOW - HOUR, over: 'stale' as const }
];
const WORKS = [undefined, work(true, 'npm run dev'), work(true, null), work(false, 'npm run dev')];

/** Every combination of what a row's section and second line read. */
function* every(): Generator<TerminalInfo> {
  for (const state of STATES) for (const waitingFor of WAITS) for (const activity of ACTIVITIES) for (const errorReason of REASONS)
    for (const limitPause of PAUSES) for (const w of WORKS) for (const compacting of [false, true]) for (const unread of [false, true]) {
      yield term(session({ state, waitingFor, activity, errorReason, unread, compacting, ...(limitPause ? { limitPause } : {}) }), w);
    }
}

test('a row\'s section is the sidebar\'s, for every state', () => {
  let n = 0;
  for (const t of every()) { expect(sectionOf(t), JSON.stringify(t.session)).toBe(inboxSection(t)); n++; }
  expect(n).toBeGreaterThan(10_000);
  // A plain terminal, and a session still starting (no session yet): Idle.
  expect(sectionOf(term(null))).toBe(inboxSection(term(null)));
});

test('a row\'s second line is the sidebar\'s, word for word, for every state', () => {
  for (const t of every()) {
    const mine = detailOf(t, { starting: false, now: NOW });
    const theirs = sessionSubtitle(t.session!, words.stateLabel, undefined, t.work, NOW)?.text ?? null;
    expect(mine, JSON.stringify(t.session)).toBe(theirs);
  }
});

test('a starting session says so; a plain terminal has no second line', () => {
  expect(detailOf(term(null), { starting: true, now: NOW })).toBe(words.starting);
  expect(detailOf(term(null), { starting: false, now: NOW })).toBeNull();
});

test('the usage limit\'s reset in local words: today\'s clock, tomorrow, another day', () => {
  const at = (resetsAt: number | null) => detailOf(term(session({ state: 'error', errorReason: 'rate_limit', limitPause: { since: NOW, resetsAt } })), { starting: false, now: NOW });
  expect(at(new Date(2026, 10, 23, 15, 45).getTime())).toBe('Usage limit · continues at 15:45');
  expect(at(new Date(2026, 10, 24, 1, 30).getTime())).toBe('Usage limit · continues tomorrow at 01:30');
  expect(at(new Date(2026, 10, 26, 9, 0).getTime())).toBe('Usage limit · continues Thu 26 Nov at 09:00');
  expect(at(null)).toBe('Usage limit');
});

test('a long activity is cut to 120 characters', () => {
  const long = detailOf(term(session({ state: 'running', activity: `Bash ${'x'.repeat(300)}` })), { starting: false, now: NOW })!;
  expect(long).toHaveLength(MAX_DETAIL);
  expect(long.endsWith('…')).toBe(true);
});

test('a permission\'s target while waiting for one, cut to 60 characters; nothing otherwise', () => {
  expect(permissionOf(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' }))).toBe('Bash npm test');
  expect(permissionOf(session({ state: 'waiting', waitingFor: 'permission', activity: `waiting: Bash ${'y'.repeat(100)}` }))).toHaveLength(60);
  expect(permissionOf(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting for you' }))).toBeNull();
  expect(permissionOf(session({ state: 'waiting', waitingFor: 'question', activity: 'waiting: question' }))).toBeNull();
  expect(permissionOf(session({ state: 'running', activity: 'waiting: Bash npm test' }))).toBeNull();
  expect(permissionOf(null)).toBeNull();
  expect(isPlanApproval(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: plan approval' }))).toBe(true);
  expect(isPlanApproval(session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' }))).toBe(false);
});

test('a wait\'s key: only for a permission the row can answer, the same for the whole wait, another for the next one', () => {
  const book = new WaitBook();
  const waiting = session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test', updatedAt: 10 });
  const key = book.keyOf({ id: 't1', session: waiting })!;
  expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
  // Later events of the same wait (a subagent's tool call, the status line) move updatedAt: the same key.
  expect(book.keyOf({ id: 't1', session: { ...waiting, updatedAt: 11, contextPct: 40 } })).toBe(key);
  book.update([{ id: 't1', session: { ...waiting, updatedAt: 12 } }]);
  expect(book.keyOf({ id: 't1', session: { ...waiting, updatedAt: 13 } })).toBe(key);
  // Another terminal, another target: other keys.
  expect(book.keyOf({ id: 't2', session: waiting })).not.toBe(key);
  expect(book.keyOf({ id: 't1', session: { ...waiting, activity: 'waiting: Bash rm -rf build', updatedAt: 14 } })).not.toBe(key);
  // The wait ends, and the same request comes again later: a new wait, a new key.
  book.update([{ id: 't1', session: { ...waiting, state: 'running', waitingFor: null, activity: 'Bash npm test', updatedAt: 20 } }]);
  const again = book.keyOf({ id: 't1', session: { ...waiting, updatedAt: 30 } });
  expect(again).not.toBeNull();
  expect(again).not.toBe(key);
  // No key for what the row can't answer: a question, a plan, a permission that names no request (an answer is only
  // given to the request the dialog shows), the idle notice, a usage-limit pause, no session.
  expect(book.keyOf({ id: 't1', session: { ...waiting, waitingFor: 'question', activity: 'waiting: question' } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: { ...waiting, activity: 'waiting: plan approval' } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: { ...waiting, activity: 'waiting for you' } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: { ...waiting, activity: null } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: { ...waiting, state: 'idle', waitingFor: 'input' } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: { ...waiting, state: 'error', errorReason: 'rate_limit', waitingFor: null, limitPause: { since: 1, resetsAt: null } } })).toBeNull();
  expect(book.keyOf({ id: 't1', session: null })).toBeNull();
});

test('any wait gets a key, plan and question too; the answerable book still keys only what a row can answer', () => {
  const perm = session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test', updatedAt: 10 });
  const plan = { ...perm, activity: 'waiting: plan approval' };
  const question = { ...perm, waitingFor: 'question' as const, activity: 'waiting: question' };
  const nameless = { ...perm, activity: 'waiting for you' };
  const paused = { ...perm, state: 'error' as const, errorReason: 'rate_limit', waitingFor: null, limitPause: { since: 1, resetsAt: null } } as SessionInfo;
  const every = new WaitBook(anyWait);
  const answerable = new WaitBook();
  const keys = [perm, plan, question, nameless].map((s, i) => every.keyOf({ id: `t${i}`, session: s }));
  for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(new Set(keys).size).toBe(4);
  expect([perm, plan, question, nameless].map((s, i) => answerable.keyOf({ id: `t${i}`, session: s }) !== null)).toEqual([true, false, false, false]);
  // The same wait keeps its key through later events; no key for a usage-limit pause, an idle notice or no session.
  expect(every.keyOf({ id: 't0', session: { ...perm, updatedAt: 11 } })).toBe(keys[0]);
  expect(every.keyOf({ id: 't1', session: paused })).toBeNull();
  expect(every.keyOf({ id: 't1', session: { ...perm, state: 'idle', waitingFor: 'input' } })).toBeNull();
  expect(every.keyOf({ id: 't1', session: null })).toBeNull();
  // What the dialog read expects: question, plan, permission (even one that names no request), nothing for a pause.
  expect([perm, plan, question, nameless, paused].map((s) => waitOf(s))).toEqual(['permission', 'plan', 'question', 'permission', null]);
  expect(waitOf(null)).toBeNull();
});
