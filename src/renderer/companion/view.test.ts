import { describe, expect, test } from 'vitest';
import type { CatchPoint, CatchUp, Thread, ThreadItem } from '@shared/companion/types';
import { newThread } from '@shared/companion/thread';
import type { RunView } from './model';
import {
  answerMeta, askPlaceholder, askTarget, catchUpSource, catchUpWhen, costLine, liveMarkdown, liveRuns, meterOf, placement, plainAnswer, pointTimes,
  promptText, runPhase, sessionRuns, sheetIn, suggestionsFor, suggestionsFrom, threadMarkdown, traceNow, traceRows, whyQuestion
} from './view';
import { shallow } from 'zustand/shallow';

// What the Ask panel shows: pure, so the panel only renders it.

const UUID = '11111111-1111-4111-8111-111111111111';
const at = (h: number, m: number) => new Date(2026, 9, 31, h, m).getTime();
const thread = (items: ThreadItem[] = [], o: Partial<Thread> = {}): Thread => ({ ...newThread('s1', UUID, 0), items, ...o });
const run = (o: Partial<RunView> = {}): RunView => ({ runId: 'r1', sessionId: 's1', queued: false, trace: [], traceAt: 0, text: '', questionId: 'q1', startedAt: 0, ...o });

describe('sessionRuns (what one thread view subscribes to)', () => {
  test("only the session's runs and their waiting texts; another session's delta leaves them shallow-equal (no re-render)", () => {
    const a = run({ runId: 'a', sessionId: 's1' });
    const b = run({ runId: 'b', sessionId: 's2' });
    const before = { a, b };
    const texts = { a: 'why?', b: 'other' };
    expect(sessionRuns(before, texts, 's1')).toEqual({ runs: { a }, texts: { a: 'why?' } });
    const after = { a, b: { ...b, text: 'more' } };
    expect(shallow(sessionRuns(before, texts, 's1').runs, sessionRuns(after, texts, 's1').runs)).toBe(true);
    expect(shallow(sessionRuns(before, texts, 's1').texts, sessionRuns(after, { ...texts, b: 'x' }, 's1').texts)).toBe(true);
    // Its own delta: a new run object, so the view renders it.
    expect(shallow(sessionRuns(before, texts, 's1').runs, sessionRuns({ ...after, a: { ...a, text: 'x' } }, texts, 's1').runs)).toBe(false);
  });
});

describe('askTarget', () => {
  const o = (x: Partial<Parameters<typeof askTarget>[0]> = {}) => ({ selectedId: 't1', lastSession: null, open: new Set<string>(), sessions: new Set(['t1']), shown: new Set(['t1']), ...x });
  test('the selected session: opens, or closes an open one, where it is shown', () => {
    expect(askTarget(o())).toEqual({ id: 't1', show: false, toggle: true });
    expect(askTarget(o({ open: new Set(['t1']) }))).toEqual({ id: 't1', show: false, toggle: true });
  });
  test('an ended session with Ask open is still a target (to close it); a plain terminal is not', () => {
    expect(askTarget(o({ sessions: new Set(), open: new Set(['t1']) }))).toEqual({ id: 't1', show: false, toggle: true });
    expect(askTarget(o({ sessions: new Set() }))).toBeNull();
  });
  test('the last session when the selected terminal is plain; one not on screen is shown, never closed unseen', () => {
    expect(askTarget(o({ selectedId: 't2', lastSession: 't1', shown: new Set(['t2']) }))).toEqual({ id: 't1', show: true, toggle: true });
    expect(askTarget(o({ shown: new Set(), open: new Set(['t1']) }))).toEqual({ id: 't1', show: true, toggle: false });
    expect(askTarget(o({ selectedId: null }))).toBeNull();
  });
});

describe('sheetIn', () => {
  test("a pane's terminal with Ask open as a sheet (the paste notice then moves left of it)", () => {
    const b = { terminalId: 't1', sessionId: 's1', cwd: '/p', configDir: null, title: 'x' };
    expect(sheetIn({ askOpen: { t1: b }, askDock: { t1: 'sheet' } }, 't:t1')).toBe(true);
    expect(sheetIn({ askOpen: { t1: b }, askDock: { t1: 'dock' } }, 't:t1')).toBe(false);
    expect(sheetIn({ askOpen: {}, askDock: { t1: 'sheet' } }, 't:t1')).toBe(false);
    expect(sheetIn({ askOpen: { t1: b }, askDock: { t1: 'sheet' } }, 'f:/p/a.ts')).toBe(false);
    expect(sheetIn({ askOpen: { t1: b }, askDock: { t1: 'sheet' } }, null)).toBe(false);
  });
});

describe('placement', () => {
  test('docks when the terminal keeps 480 px beside the 404 px panel, else a sheet', () => {
    expect(placement(884, false)).toEqual({ mode: 'dock', held: false, canDock: false });
    expect(placement(883, false)).toEqual({ mode: 'sheet', held: true, canDock: false });
  });
  test('a sheet stays a sheet when room comes back, and offers to dock', () => {
    expect(placement(1200, true)).toEqual({ mode: 'sheet', held: true, canDock: true });
    expect(placement(600, true)).toEqual({ mode: 'sheet', held: true, canDock: false });
  });
});

describe('runPhase', () => {
  test('running beats queued; another session’s runs don’t count', () => {
    expect(runPhase({}, 's1')).toBe('idle');
    expect(runPhase({ r1: run({ queued: true }) }, 's1')).toBe('queued');
    expect(runPhase({ r1: run({ queued: true }), r2: run({ runId: 'r2' }) }, 's1')).toBe('running');
    expect(runPhase({ r1: run({ sessionId: 's2' }) }, 's1')).toBe('idle');
  });
});

describe('askPlaceholder', () => {
  test('asks about the session until a question is in the thread', () => {
    expect(askPlaceholder(null, 'auth-refactor')).toBe('Ask about auth-refactor…');
    expect(askPlaceholder(thread([{ kind: 'error', id: 'e', at: 1, questionId: null, reason: 'timeout', message: 'x' }]), 'auth-refactor')).toBe('Ask about auth-refactor…');
    expect(askPlaceholder(thread([{ kind: 'question', id: 'q', at: 1, text: 'why?' }]), 'auth-refactor')).toBe('Ask a follow-up…');
  });
});

describe('costLine', () => {
  test("the thread's cost so far", () => {
    expect(costLine(0)).toBe('Cost so far: $0.00');
    expect(costLine(0.004)).toBe('Cost so far: <$0.01');
    expect(costLine(0.0312)).toBe('Cost so far: $0.03');
  });
});

describe('threadMarkdown', () => {
  test('every item in order, the questions as yours and the catch-up as a list', () => {
    const items: ThreadItem[] = [
      { kind: 'catchup', id: 'c', at: at(12, 41), read: [], model: 'sonnet', final: false, data: {
        points: [{ n: 1, text: 'Token store', status: 'done', at: '12:22', note: null }, { n: 2, text: 'Tests', status: 'in_progress', at: null, note: '1 of 3 left' }],
        where: 'Re-running the suite.', choices: ['Skew fixed at 30 s'], leftOpen: null } },
      { kind: 'question', id: 'q', at: at(12, 44), text: 'Why 30 s?' },
      { kind: 'answer', id: 'a', at: at(12, 45), questionId: 'q', markdown: 'Because **clocks drift**.', read: ['src/app.ts'], model: 'haiku', costUsd: 0.002 },
      { kind: 'error', id: 'e', at: at(12, 50), questionId: null, reason: 'timeout', message: "Claude didn't answer in time" }
    ];
    expect(threadMarkdown(thread(items), 'auth-refactor')).toBe([
      '# Ask about auth-refactor',
      '',
      '## Catch me up · 12:41',
      '',
      '1. [done] Token store (12:22)',
      '2. [in progress] Tests — 1 of 3 left',
      '',
      '**Where it is:** Re-running the suite.',
      '',
      '**Choices it made:**',
      '- Skew fixed at 30 s',
      '',
      '## You · 12:44',
      '',
      'Why 30 s?',
      '',
      '## Ask · Haiku · 12:45',
      '',
      'Because **clocks drift**.',
      '',
      '## Error · 12:50',
      '',
      "Claude didn't answer in time",
      ''
    ].join('\n'));
  });
  test('a final catch-up says what it left open; a stopped answer says so', () => {
    const items: ThreadItem[] = [
      { kind: 'catchup', id: 'c', at: at(9, 5), read: [], model: 'opus', final: true, data: { points: [], where: '', choices: [], leftOpen: 'The cookie path.' } },
      { kind: 'answer', id: 'a', at: at(9, 6), questionId: 'q', markdown: 'Half', read: [], model: 'sonnet', costUsd: null, stopped: true }
    ];
    const md = threadMarkdown(thread(items), 'x');
    expect(md).toContain('## Catch me up (final) · 09:05');
    expect(md).toContain('**Left open:** The cookie path.');
    expect(md).toContain('## Ask · Sonnet · 09:06 · Stopped');
  });
});

// Catch me up.
const pt = (n: number, status: CatchPoint['status'], at: string | null = null, note: string | null = null): CatchPoint => ({ n, text: `Point ${n}`, status, at, note });
const BOARD: CatchUp = {
  points: [pt(1, 'done', '12:22'), pt(2, 'done', '12:33'), pt(3, 'in_progress', null, 'Re-running them · 1 of 3 failures left'), pt(4, 'not_started'), pt(5, 'not_started', '12:38')],
  where: 'Refresh tokens now live in `TokenStore` and expiry allows 30 s of clock skew. It changed the check to `<=` and is re-running the suite.',
  choices: ['Skew window fixed at 30 s, not configurable', 'Plans to keep reading the old cookie for one release'],
  leftOpen: null
};
const catchup = (data: CatchUp, o: Partial<Extract<ThreadItem, { kind: 'catchup' }>> = {}): ThreadItem => ({ kind: 'catchup', id: 'c', at: 1, data, read: [], model: 'sonnet', final: false, ...o });

describe('suggestionsFrom', () => {
  test("what's left, why the first choice, and how the code the summary names works", () => {
    expect(suggestionsFrom(BOARD)).toEqual(["What's left?", 'Why skew window fixed at 30 s, not configurable?', 'How does TokenStore work?']);
  });
  test("always \"What's left?\" when something was asked; nothing else without choices or code in the summary", () => {
    expect(suggestionsFrom({ ...BOARD, choices: [], where: 'Re-running the suite.' })).toEqual(["What's left?"]);
  });
  test('nothing asked yet (no points): no suggestion at all, "What\'s left?" would be a dead end', () => {
    expect(suggestionsFrom({ points: [], where: 'Nothing asked yet', choices: [], leftOpen: null })).toEqual([]);
  });
  test('the first choice whose question fits in 60 characters; none fits: no why', () => {
    const long = 'Kept every legacy cookie reader alive until the next major release ships';
    expect(suggestionsFrom({ ...BOARD, choices: [long, 'Skipped the docs.'], where: '' })).toEqual(["What's left?", 'Why skipped the docs?']);
    expect(suggestionsFrom({ ...BOARD, choices: [long], where: '' })).toEqual(["What's left?"]);
  });
  test('code in the summary: an identifier asks how it works, a file what changed in it; operators, plain words and long ones are skipped', () => {
    const from = (where: string) => suggestionsFrom({ ...BOARD, choices: [], where });
    expect(from('It added `refresh()` to the store.')).toEqual(["What's left?", 'How does refresh() work?']);
    expect(from('Most of it is in `src/auth/session.ts`.')).toEqual(["What's left?", 'What changed in src/auth/session.ts?']);
    expect(from('Compares with `<=`, sets `true` and `SKEW_MS`.')).toEqual(["What's left?"]);
    expect(from('Then `<=`, then `tokenStore`.')).toEqual(["What's left?", 'How does tokenStore work?']);
    expect(from(`See \`src/${'deep/'.repeat(12)}x.ts\`.`)).toEqual(["What's left?"]);
  });
  test('a file is a path or a name with a source extension: `TokenStore.get` is code, `v2.9` is neither', () => {
    const from = (where: string) => suggestionsFrom({ ...BOARD, choices: [], where });
    expect(from('It calls `TokenStore.get` first.')).toEqual(["What's left?", 'How does TokenStore.get work?']);
    expect(from('Since `v2.9` it does.')).toEqual(["What's left?"]);
    expect(from('See `config.yaml`.')).toEqual(["What's left?", 'What changed in config.yaml?']);
    expect(from('See `App.tsx:12`.')).toEqual(["What's left?", 'What changed in App.tsx?']);
    expect(from('See `docs/notes`.')).toEqual(["What's left?", 'What changed in docs/notes?']);
  });
  test('a final one asks about the code what it left open names first (the card shows it instead of where it is)', () => {
    expect(suggestionsFrom({ ...BOARD, choices: [], leftOpen: 'Nothing handles `src/auth/password.ts` yet.' })).toEqual(["What's left?", 'What changed in src/auth/password.ts?']);
    expect(suggestionsFrom({ ...BOARD, choices: [], leftOpen: 'The boundary test is still red.' })).toEqual(["What's left?", 'How does TokenStore work?']);
  });
  test('at most three, each at most 60 characters', () => {
    for (const c of [BOARD, { ...BOARD, choices: ['A'.repeat(100)] }]) {
      const s = suggestionsFrom(c);
      expect(s.length).toBeLessThanOrEqual(3);
      for (const x of s) expect(x.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('whyQuestion', () => {
  test('lowercases a plain first word, keeps names and acronyms, drops the trailing period and backticks', () => {
    expect(whyQuestion('Skew window fixed at 30 s.')).toBe('Why skew window fixed at 30 s?');
    expect(whyQuestion('A single-flight refresh')).toBe('Why a single-flight refresh?');
    expect(whyQuestion('TokenStore keeps the refresh token')).toBe('Why TokenStore keeps the refresh token?');
    expect(whyQuestion('API calls are retried twice.')).toBe('Why API calls are retried twice?');
    expect(whyQuestion('I kept the cookie')).toBe('Why I kept the cookie?');
    expect(whyQuestion('Compared expiry with `<=`…')).toBe('Why compared expiry with <=?');
    expect(whyQuestion('  Kept it?  ')).toBe('Why kept it?');
  });
  test('asks about what the choice reads as: a link by its label, bold without its stars', () => {
    expect(whyQuestion('Based it on [F15](https://acme-store.test/t/15), the **export** case.')).toBe('Why based it on F15, the export case?');
    expect(whyQuestion('https://acme-store.test/t/15 as the base')).toBe('Why https://acme-store.test/t/15 as the base?');
  });
});

describe('pointTimes', () => {
  test('the time it finished, now, next for the first not started, then when it was asked', () => {
    expect(pointTimes(BOARD.points, false)).toEqual([
      { text: '12:22', tone: 'time' }, { text: '12:33', tone: 'time' }, { text: 'now', tone: 'now' }, { text: 'next', tone: 'next' }, { text: 'asked 12:38', tone: 'asked' }
    ]);
  });
  test('nothing to say: a done point without a time, a later not started one without one, an unclear one', () => {
    expect(pointTimes([pt(1, 'done'), pt(2, 'not_started', '10:00'), pt(3, 'not_started'), pt(4, 'unclear', '11:00')], false)).toEqual([
      null, { text: 'next', tone: 'next' }, null, null
    ]);
  });
  test('a final one (the session ended): whatever is not done says so', () => {
    expect(pointTimes([pt(1, 'done', '12:58'), pt(2, 'in_progress'), pt(3, 'not_started', '12:38'), pt(4, 'unclear')], true)).toEqual([
      { text: '12:58', tone: 'time' }, { text: 'not done', tone: 'open' }, { text: 'not done', tone: 'open' }, null
    ]);
  });
});

describe('catchUpWhen', () => {
  test('its clock time and how long ago, by the minute, the hour, then the day', () => {
    const made = at(12, 41);
    expect(catchUpWhen(made, made + 20_000, false)).toBe('12:41 · just now');
    expect(catchUpWhen(made, made + 2 * 60_000 + 59_000, false)).toBe('12:41 · 2 min ago');
    expect(catchUpWhen(made, made + 3 * 3_600_000, false)).toBe('12:41 · 3 h ago');
    expect(catchUpWhen(made, made + 26 * 3_600_000, false)).toBe('12:41 · yesterday');
    expect(catchUpWhen(made, made - 5_000, false)).toBe('12:41 · just now');
  });
  test('a final one says so, with its time only', () => {
    expect(catchUpWhen(at(13, 2), at(14, 0), true)).toBe('final · 13:02');
  });
});

describe('catchUpSource', () => {
  test('the chat, and the files it read when it read some', () => {
    expect(catchUpSource([])).toBe('From the chat');
    expect(catchUpSource(['src/app.ts'])).toBe('From the chat and 1 file');
    expect(catchUpSource(['a.ts', 'b.ts', 'c.ts'])).toBe('From the chat and 3 files');
  });
});

describe('suggestionsFor', () => {
  test("right after a Catch me up and while nothing runs; never in an empty thread (its own starters) or after a question", () => {
    expect(suggestionsFor(thread([catchup(BOARD)]), false)).toEqual(suggestionsFrom(BOARD));
    expect(suggestionsFor(thread([catchup(BOARD)]), true)).toEqual([]);
    expect(suggestionsFor(thread([]), false)).toEqual([]);
    expect(suggestionsFor(null, false)).toEqual([]);
    expect(suggestionsFor(thread([catchup(BOARD), { kind: 'question', id: 'q', at: 2, text: 'why?' }]), false)).toEqual([]);
  });
});

// --- Answers (3 and 7) ----------------------------------------------------------------------------

type Answer = Extract<ThreadItem, { kind: 'answer' }>;
const answer = (o: Partial<Answer> = {}): Answer => ({ kind: 'answer', id: 'a1', at: 1, questionId: 'q1', markdown: 'x', read: [], model: 'sonnet', costUsd: null, ...o });

describe('answerMeta', () => {
  test('the model, what it read, and Stopped for a stopped one (what read the chat only says nothing)', () => {
    expect(answerMeta(answer({ read: ['src/a.ts', 'src/b.ts'] }))).toEqual(['Sonnet', 'read 2 files']);
    expect(answerMeta(answer({ model: 'haiku', read: ['src/a.ts'] }))).toEqual(['Haiku', 'read 1 file']);
    expect(answerMeta(answer({ model: 'opus' }))).toEqual(['Opus']);
    expect(answerMeta(answer({ read: ['a.ts'], stopped: true }))).toEqual(['Sonnet', 'read 1 file', 'Stopped']);
  });
});

describe('meterOf', () => {
  test('one segment per step, n filled', () => {
    expect(meterOf({ n: 2, m: 3 })).toEqual({ total: 3, filled: 2 });
    expect(meterOf({ n: 0, m: 5 })).toEqual({ total: 5, filled: 0 });
    expect(meterOf({ n: 10, m: 10 })).toEqual({ total: 10, filled: 10 });
  });
  test('capped at ten segments, filled in proportion: never empty once begun, never full before the end', () => {
    expect(meterOf({ n: 7, m: 20 })).toEqual({ total: 10, filled: 4 });
    expect(meterOf({ n: 1, m: 300 })).toEqual({ total: 10, filled: 1 });
    expect(meterOf({ n: 299, m: 300 })).toEqual({ total: 10, filled: 9 });
    expect(meterOf({ n: 300, m: 300 })).toEqual({ total: 10, filled: 10 });
    expect(meterOf({ n: 0, m: 300 })).toEqual({ total: 10, filled: 0 });
  });
});

describe('promptText (Use as prompt)', () => {
  test('the Markdown without its verdict line', () => {
    expect(promptText('Verdict: in-progress — Not yet · 2/3\n\nStill red.\n\n1. a\n2. b\n')).toBe('Still red.\n\n1. a\n2. b');
    expect(promptText('\n\nVerdict: done — Yes\nAll green.')).toBe('All green.');
  });
  test('a first line that is no verdict stays (an unknown state, or a verdict further down)', () => {
    expect(promptText('Verdict: maybe — who knows\nText')).toBe('Verdict: maybe — who knows\nText');
    expect(promptText('Intro\nVerdict: done — Yes')).toBe('Intro\nVerdict: done — Yes');
    expect(promptText(':::detail Why\nbody\n:::')).toBe(':::detail Why\nbody\n:::');
  });
  test('a leading ! or / is neutralized: never Claude Code\'s bash mode or a slash command once sent', () => {
    expect(promptText('!rm -rf build')).toBe(' !rm -rf build');
    expect(promptText('Verdict: done — Yes\n\n/clear and start over')).toBe(' /clear and start over');
    expect(promptText('  /compact')).toBe(' /compact');
    // Further down, or after other text: as written.
    expect(promptText('Run it:\n!npm test')).toBe('Run it:\n!npm test');
    expect(promptText('a/b')).toBe('a/b');
  });
  test('a verdict-only answer leaves nothing', () => {
    expect(promptText('Verdict: done — Yes')).toBe('');
  });
});

describe('liveMarkdown (while it streams)', () => {
  test('a Detail still being written is drawn as its box', () => {
    expect(liveMarkdown('Intro\n\n:::detail Why\nbecause')).toBe('Intro\n\n:::detail Why\nbecause\n:::');
    expect(liveMarkdown(':::detail Why\nbody\n:::\nafter')).toBe(':::detail Why\nbody\n:::\nafter');
    expect(liveMarkdown(':::detail A\na\n:::\n:::detail B\nb')).toBe(':::detail A\na\n:::\n:::detail B\nb\n:::');
  });
  test('a verdict line waits for its end (no half verdict as text)', () => {
    expect(liveMarkdown('Verdict: in-prog')).toBe('');
    expect(liveMarkdown('  Verdict: done — Ye')).toBe('');
    expect(liveMarkdown('Verdict: done — Yes\nAll')).toBe('Verdict: done — Yes\nAll');
    expect(liveMarkdown('Verdi')).toBe('');
    expect(liveMarkdown('Very well')).toBe('Very well');
  });
});

describe('traceNow and traceRows (the reading trace)', () => {
  test('the current step in the present tense', () => {
    expect(traceNow('Read src/auth/token-store.ts')).toBe('Reading src/auth/token-store.ts');
    expect(traceNow('Read the chat')).toBe('Reading the chat');
    expect(traceNow("Searched the chat for 'skew'")).toBe("Searching the chat for 'skew'");
    expect(traceNow("Searched the code for 'x'")).toBe("Searching the code for 'x'");
    expect(traceNow('Listed src/**/*.ts')).toBe('Listing src/**/*.ts');
    expect(traceNow('Something else')).toBe('Something else');
  });
  test('earlier steps done, the last one current until text arrives after it', () => {
    const r = run({ trace: ["Searched the chat for 'skew'", 'Read src/a.ts'], traceAt: 0, text: '' });
    expect(traceRows(r)).toEqual([{ text: "Searched the chat for 'skew'", now: false }, { text: 'Reading src/a.ts', now: true }]);
    expect(traceRows({ ...r, text: 'It' })).toEqual([{ text: "Searched the chat for 'skew'", now: false }, { text: 'Read src/a.ts', now: false }]);
    expect(traceRows(run({ trace: [] }))).toEqual([]);
  });
});

describe('liveRuns (what the thread shows of the runs on their way)', () => {
  const q = (id: string): ThreadItem => ({ kind: 'question', id, at: 1, text: id });
  test('a running or waiting run of a question in the thread follows that question', () => {
    const runs = { r1: run({ runId: 'r1', questionId: 'q1' }), r2: run({ runId: 'r2', questionId: 'q2', queued: true }) };
    const v = liveRuns(thread([q('q1'), q('q2')]), runs, {}, 's1');
    expect(v.byQuestion).toEqual({ q1: runs.r1, q2: runs.r2 });
    expect(v.held).toEqual([]);
  });
  test('a question still held (not in the thread yet) shows from its text, once; one without its text waits unseen', () => {
    const runs = { r1: run({ runId: 'r1', questionId: 'q1' }), r2: run({ runId: 'r2', questionId: 'q2', queued: true }), r3: run({ runId: 'r3', questionId: 'q3', queued: true }) };
    const v = liveRuns(thread([q('q1')]), runs, { r2: 'And the tests?', r1: 'q1' }, 's1');
    expect(v.held).toEqual([{ runId: 'r2', text: 'And the tests?' }]);
    expect(Object.keys(v.byQuestion)).toEqual(['q1']);
  });
  test('settled questions, Catch me up runs and other sessions are left out', () => {
    const runs = { r1: run({ runId: 'r1', questionId: 'q1' }), c: run({ runId: 'c', questionId: null }), o: run({ runId: 'o', sessionId: 's2', questionId: 'qx' }) };
    const done = thread([q('q1'), answer({ questionId: 'q1' })]);
    expect(liveRuns(done, runs, { o: 'x' }, 's1')).toEqual({ byQuestion: {}, held: [] });
    const failed = thread([q('q1'), { kind: 'error', id: 'e', at: 2, questionId: 'q1', reason: 'timeout', message: 'm' }]);
    expect(liveRuns(failed, runs, {}, 's1').byQuestion).toEqual({});
  });
});

describe('plainAnswer (what a screen reader hears when an answer lands)', () => {
  test('the verdict and the opening text, without Markdown, cut short', () => {
    expect(plainAnswer('Verdict: in-progress — Not yet · 2/3\n\nTwo **pass** now; see `src/a.ts:2`.')).toBe('Not yet · 2/3. Two pass now; see src/a.ts:2.');
    expect(plainAnswer('1. one\n2. two')).toBe('one');
    expect(plainAnswer('x'.repeat(400))).toHaveLength(201);
    expect(plainAnswer('')).toBe('');
  });
  test('a link reads as its label, never its Markdown', () => {
    expect(plainAnswer('Created [the **F15** task](https://acme-store.test/t/15), see https://acme-store.test/t/11.')).toBe('Created the F15 task, see https://acme-store.test/t/11.');
    expect(plainAnswer('- [F15](https://acme-store.test/t/15)')).toBe('F15');
  });
});
