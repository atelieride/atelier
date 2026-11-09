// Ask in the live demo: what the read-only companion says about each of the five
// sessions of the fictional acme-store (scenarios.ts, beats.ts), as data. No model runs in a browser: a session's Catch me
// up and its status answers come from the phase it is in now (the first phase whose condition holds, engine/ask.ts), its
// Why? and code answers are its own. Answers are written in the app's answer grammar: a
// `Verdict:` line first on status answers, `:::detail` boxes, backticked `path:line` references to the project's files.
// Loaded on first use (bridge/companion.ts): never part of the demo's first paint.
import type { PointStatus } from '@shared/companion/types';
import type { SessionState } from '@shared/session';
import type { ScenarioName } from './scenarios';

/** A scripted answer: its Markdown, the project files it read and the code it searched (its trace, in that order). */
export interface AskAnswer { md: string; read?: readonly string[]; search?: readonly string[] }

/** A Catch me up point; `at: 'turn'`: done when the session's turn last ended (its last message, Atelier's fact). */
export interface AskPoint { text: string; status: PointStatus; at?: 'turn'; note?: string }

export interface AskCatchUp { points: readonly AskPoint[]; where: string; choices: readonly string[]; leftOpen: string | null; read: readonly string[] }

/**
 * When a phase is the session's now: every condition given holds — its state (once its scripted turn has ended: idle
 * after Esc, done after its Stop), a text in its activity, a file's text, whether Esc ended its scripted turn, and a
 * text its terminal had printed when that turn ended (how far it really got).
 */
export interface AskWhen {
  states?: readonly SessionState[];
  waits?: string;
  file?: { rel: string; has?: string; lacks?: string };
  interrupted?: boolean;
  printed?: string;
}

/**
 * Where a session is: its Catch me up and its status answers — `status` for "What's left?" and "How far along is it?",
 * `doing` for "What is it doing?", `plan` for "Explain its plan", `decide` for Help me decide while it waits — and the
 * answers that differ in this phase (a file it is still changing).
 */
export interface AskPhase {
  id: string;
  when?: AskWhen;
  catchUp: AskCatchUp;
  status: AskAnswer;
  doing: AskAnswer;
  plan: AskAnswer;
  decide?: AskAnswer;
  answers?: Readonly<Record<string, AskAnswer>>;
}

/** A scripted session: its phases, tried in order (the last one is the default), and its answers by question. */
export interface AskSession { phases: readonly AskPhase[]; answers: Readonly<Record<string, AskAnswer>> }

/** Where the visitor's latest prompt is: the session waits for them, works on it, is done with it, or Esc stopped it. */
export type VisitorState = 'waiting' | 'working' | 'done' | 'stopped';

export interface AskScript {
  sessions: Readonly<Record<ScenarioName, AskSession>>;
  /** A prompt the visitor typed: "where it is" and the status answers for it ({prompt}: the prompt, {wait}: what it waits for). */
  visitor: { where: Readonly<Record<VisitorState, string>>; status: Readonly<Record<VisitorState, AskAnswer>>; plan: AskAnswer; decide: AskAnswer };
  /** A new session nobody prompted yet. */
  nothingAsked: { where: string; status: AskAnswer };
  /** Help me decide when the session asks nothing. */
  notAsking: AskAnswer;
  /** Anything the script doesn't know (its wording). */
  fallback: AskAnswer;
}

const md = (...lines: string[]): string => lines.join('\n');

// --- auth-refactor: "Move sessions to the token store"; waits on `npm test -- auth`, then fixes the skew -------------

const AUTH_C1 = '30 s of clock skew when a session expires';
const AUTH_C2 = 'Deleting expired tokens on read';
const AUTH_MOVE: AskPoint = { text: 'Move sessions to the token store', status: 'done', at: 'turn', note: 'Expiry goes through the store, with 30 s of skew' };
const AUTH_CHECK = 'Check it with the auth tests';
const AUTH_STEPS = ['1. Expire sessions through the store, dropping an expired token as it is read', '2. Allow 30 s of clock skew on the expiry', '3. Run `npm test -- auth`, fix what fails, run it again'];
const authPlan = (head: string, marks: [string, string, string]): AskAnswer => ({
  md: md(head, '', ...AUTH_STEPS.map((s, i) => `${s} (${marks[i]}).`)), read: ['src/auth/session.ts']
});
const AUTH_CHANGES = md(
  'Everything is in `readSession` (`src/auth/session.ts:11–19`):', '',
  '- `now` is a parameter, `Date.now()` by default.',
  '- The expiry allows 30 s of clock skew, `SKEW_MS` (line 9).',
  '- An expired token is dropped from the store as it is read (line 15).'
);
const AUTH_WHAT_CHANGED = "What changed in src/auth/session.ts?";
// What its terminal prints (the beat's vitest summaries): the first run's failure, the second run's pass.
const AUTH_FIRST_RUN = '6 passed (7)';
const AUTH_PASSED = '7 passed (7)';
const AUTH_CHANGES_FIXED: AskAnswer = {
  md: md(AUTH_CHANGES, '- After the first test run, the comparison **adds** the skew (`src/auth/session.ts:14`): a token is accepted until 30 s after it expires. The first version subtracted it and refused tokens 30 s early.'),
  read: ['src/auth/session.ts']
};

const AUTH: AskSession = {
  phases: [
    {
      id: 'waiting',
      when: { states: ['waiting'], waits: 'npm test' },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'in_progress', note: 'Waiting for your OK to run `npm test -- auth`' }],
        where: 'It reworked how `readSession` expires sessions in `src/auth/session.ts`: through the store, with 30 s of clock skew. Then it stopped to ask before running `npm test -- auth`.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The move is written but untested: `npm test -- auth` never ran.',
        read: ['src/auth/session.ts', 'src/auth/tokens.ts']
      },
      status: {
        md: md(
          'Verdict: in-progress — Waiting for your OK · 1/2', '',
          'The move is written: `readSession` drops an expired token from the store and allows 30 s of clock skew (`src/auth/session.ts:11–19`). What is left is the check: it asked to run `npm test -- auth`, and waits for your answer in its terminal.', '',
          ':::detail One thing the tests may catch',
          '`src/auth/session.ts:14` subtracts `SKEW_MS` from the expiry, so a token is refused 30 s *before* it expires. A margin for clock skew usually goes the other way: valid until 30 s *after*.',
          ':::'
        ),
        read: ['src/auth/session.ts']
      },
      doing: { md: md('Verdict: in-progress — Waiting for you', '', 'Nothing runs right now. It finished its edit to `src/auth/session.ts` and asks whether it may run `npm test -- auth`: press **1** in its terminal to allow it, **3** to say no.') },
      plan: authPlan('Three steps, two done:', ['done', 'done', 'waiting for your OK']),
      decide: {
        md: md(
          '**Allowing it is safe.** `npm test -- auth` runs the auth tests with vitest: it reads the code and changes no file.', '',
          '- **1, Yes**: the tests run now; if one fails, it fixes `src/auth/session.ts` and runs them again.',
          '- **3, No**: nothing runs, and the move stays untested.', '',
          ':::detail Worth knowing before you answer',
          'The expiry check at `src/auth/session.ts:14` subtracts the skew: a token is refused 30 s before it expires instead of 30 s after. A test of the skew would fail on it, which is what the run is for.',
          ':::'
        ),
        read: ['src/auth/session.ts']
      }
    },
    {
      id: 'working',
      when: { states: ['running'] },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'in_progress', note: 'Running `npm test -- auth`; fixing what fails' }],
        where: 'You allowed the test run: it is running `npm test -- auth` and fixes what fails in `src/auth/session.ts` before it reports back.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The test run was still going: the move is not confirmed yet.',
        read: ['src/auth/session.ts']
      },
      status: { md: md('Verdict: in-progress — Running the auth tests · 1/2', '', 'The move is done; the check is running now. If a test fails it fixes `src/auth/session.ts` and runs them again, then says so in its terminal.') },
      doing: { md: md('Verdict: in-progress — Running the auth tests', '', 'It is running `npm test -- auth`, as you allowed. A failure sends it back to `src/auth/session.ts`; a green run ends its turn.') },
      plan: authPlan('Three steps, the last one under way:', ['done', 'done', 'running now']),
      answers: {
        [AUTH_WHAT_CHANGED]: { md: md(AUTH_CHANGES, '', 'It is testing these lines right now: if a test fails, it changes `src/auth/session.ts` again.'), read: ['src/auth/session.ts'] }
      }
    },
    {
      // Its second run passed (its turn finished, or Esc once "7 passed" was on screen): true either way.
      id: 'fixed',
      when: { printed: AUTH_PASSED },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'done', at: 'turn', note: 'All 7 pass, after one fix to the skew' }],
        where: 'The first test run caught the skew applied the wrong way round; it fixed the comparison in `src/auth/session.ts:14`, and the second run passed: 7 of 7.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: '`TokenStore` has no `delete()` yet, though `src/auth/session.ts:15` calls it.',
        read: ['src/auth/session.ts', 'src/auth/tokens.ts']
      },
      status: {
        md: md(
          'Verdict: done — Moved and tested · 2/2', '',
          'Sessions expire through the store, and the auth tests pass after one fix to the skew (`src/auth/session.ts:14`).', '',
          'One thing outside what you asked: `src/auth/session.ts:15` calls `store.delete()`, and `TokenStore` has no `delete()` yet (`src/auth/tokens.ts:1–11`). Worth a follow-up prompt.'
        ),
        read: ['src/auth/session.ts', 'src/auth/tokens.ts']
      },
      doing: { md: md('Verdict: done — At its prompt', '', 'Nothing is running, and it waits for your next request. Its second test run passed: 7 of 7.') },
      plan: authPlan('Its plan is done:', ['done', 'done', 'done: one fix to the skew, then 7 of 7']),
      answers: { [AUTH_WHAT_CHANGED]: AUTH_CHANGES_FIXED }
    },
    {
      // Esc during the second test run, before it reported: the fix is written, the run's result not shown.
      id: 'interrupted',
      when: { interrupted: true, file: { rel: 'src/auth/session.ts', has: 'entry.expiresAt + SKEW_MS < now' } },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'unclear', note: 'Fixed the skew; you interrupted the run that checks it' }],
        where: 'You interrupted its second test run before it reported: the fix to the skew is in `src/auth/session.ts:14`, and its terminal shows how far the run got.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The second test run: interrupted before it reported on the fix.',
        read: ['src/auth/session.ts']
      },
      status: {
        md: md(
          'Verdict: unclear — Fixed, result not shown · 1/2', '',
          'The move is written, and the first test run led to a fix: the comparison at `src/auth/session.ts:14` now adds the skew. You interrupted the second run before it reported; `npm test -- auth` tells.'
        ),
        read: ['src/auth/session.ts']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted its second test run, and it waits for your next request.') },
      plan: authPlan('Its plan, interrupted at the end:', ['done', 'done', 'the fix is in; the second run was interrupted']),
      answers: { [AUTH_WHAT_CHANGED]: AUTH_CHANGES_FIXED }
    },
    {
      // Esc after the first run's failure, before the fix.
      id: 'first-run',
      when: { interrupted: true, printed: AUTH_FIRST_RUN },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'unclear', note: 'First run: 1 of 7 failed; you interrupted it before the fix' }],
        where: 'Its first test run reported 1 of 7 failing, a token inside the clock skew refused, and you interrupted it before it fixed `src/auth/session.ts:14`.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The failing test: `src/auth/session.ts:14` still applies the skew the wrong way round.',
        read: ['src/auth/session.ts']
      },
      status: {
        md: md(
          'Verdict: unclear — 1 of 7 failing, not fixed · 1/2', '',
          'The move is written and the tests ran once: 6 passed, 1 failed. The failure is the skew at `src/auth/session.ts:14`, subtracted where it should be added; you interrupted it before the fix.'
        ),
        read: ['src/auth/session.ts']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted it after its first test run, and it waits for your next request.') },
      plan: authPlan('Its plan, interrupted midway:', ['done', 'done', 'one run, 1 of 7 failing; interrupted before the fix']),
      answers: {
        [AUTH_WHAT_CHANGED]: {
          md: md(AUTH_CHANGES, '', ':::detail The failing test', '`entry.expiresAt - SKEW_MS < now` (`src/auth/session.ts:14`) refuses a token 30 s *before* it expires: the test of the skew failed on it. A margin for clock skew adds it instead.', ':::'),
          read: ['src/auth/session.ts']
        }
      }
    },
    {
      // Esc during the first run, before it reported.
      id: 'cut',
      when: { interrupted: true },
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'unclear', note: 'You interrupted its first test run' }],
        where: 'You interrupted its first test run before it reported: `src/auth/session.ts` expires sessions through the store now, and its terminal shows how far the run got.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The test run: interrupted before it reported.',
        read: ['src/auth/session.ts']
      },
      status: {
        md: md(
          'Verdict: unclear — Run interrupted · 1/2', '',
          'The move is written; its first test run was interrupted before it reported, so nothing says yet whether it passes. `npm test -- auth` tells.', '',
          ':::detail Before you run them',
          '`src/auth/session.ts:14` subtracts `SKEW_MS`, so a token is refused 30 s before it expires. A test of the skew would fail on that line.',
          ':::'
        ),
        read: ['src/auth/session.ts']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted its test run, and it waits for your next request.') },
      plan: authPlan('Its plan, interrupted:', ['done', 'done', 'interrupted during the first run']),
      answers: {
        [AUTH_WHAT_CHANGED]: {
          md: md(AUTH_CHANGES, '', ':::detail The comparison', '`entry.expiresAt - SKEW_MS < now` (`src/auth/session.ts:14`) refuses a token 30 s *before* it expires. A margin for clock skew adds it instead.', ':::'),
          read: ['src/auth/session.ts']
        }
      }
    },
    {
      // Its turn ended without a run: you said no to `npm test -- auth`.
      id: 'stopped',
      catchUp: {
        points: [AUTH_MOVE, { text: AUTH_CHECK, status: 'not_started', note: 'Not run: `npm test -- auth` is ready when you are' }],
        where: 'It stopped before its tests: `src/auth/session.ts` expires sessions through the store now, and no test has run on it.',
        choices: [AUTH_C1, AUTH_C2],
        leftOpen: 'The move is untested, and `src/auth/session.ts:14` still applies the skew the wrong way round.',
        read: ['src/auth/session.ts']
      },
      status: {
        md: md(
          'Verdict: not-started — Not tested yet · 1/2', '',
          'The move is written; the check is not. Run them with `npm test -- auth`, or ask the session to.', '',
          ':::detail Before you run them',
          '`src/auth/session.ts:14` subtracts `SKEW_MS`, so a token is refused 30 s before it expires. A test of the skew would fail on that line.',
          ':::'
        ),
        read: ['src/auth/session.ts']
      },
      doing: { md: md('Verdict: done — At its prompt', '', 'Nothing is running: it stopped before the auth tests, and waits for your next request.') },
      plan: authPlan('Its plan, as it stands:', ['done', 'done', 'not done: it stopped before']),
      answers: {
        [AUTH_WHAT_CHANGED]: {
          md: md(AUTH_CHANGES, '', ':::detail The comparison', '`entry.expiresAt - SKEW_MS < now` (`src/auth/session.ts:14`) refuses a token 30 s *before* it expires. A margin for clock skew adds it instead.', ':::'),
          read: ['src/auth/session.ts']
        }
      }
    }
  ],
  answers: {
    'How does readSession work?': {
      md: md(
        '`readSession(token)` turns a session token into the signed-in user, or `null`:', '',
        '1. It looks the token up in the store (`src/auth/session.ts:12`).',
        '2. No entry: not signed in, `null`.',
        '3. An entry past its expiry, give or take 30 s of clock skew (line 14): the token is dropped from the store, and the answer is `null`.',
        '4. Otherwise: the user id, and when the session expires.', '',
        ':::detail Why `now` is a parameter',
        'It defaults to `Date.now()` (`src/auth/session.ts:11`), but a test can pass a fixed time and check the skew without waiting 30 s.',
        ':::'
      ),
      read: ['src/auth/session.ts']
    },
    [`Why ${AUTH_C1}?`]: {
      md: md(
        "Servers' clocks drift a little. If the server that checks a session runs a few seconds ahead of the one that issued it, a token looks expired too early and signs someone out in the middle of a request.", '',
        '`SKEW_MS` (`src/auth/session.ts:9`) is that margin. 30 s is a common pick: wide enough for drifting clocks, short enough not to keep a dead session alive. Nothing in the chat says you asked for it; it chose the value while reworking the expiry.', '',
        ':::detail Which way it should go',
        "For a margin in the token's favour the skew is **added** to the expiry: a token stays valid until 30 s after `expiresAt`. The comparison is at `src/auth/session.ts:14`.",
        ':::'
      ),
      read: ['src/auth/session.ts'],
      search: ['SKEW_MS']
    },
    'Why deleting expired tokens on read?': {
      md: md(
        'So an expired token is only ever found once. The first time `readSession` sees it past its time, `src/auth/session.ts:15` removes it from the store, instead of leaving it there for something else to clean up.', '',
        ':::detail What to check',
        '`TokenStore` (`src/auth/tokens.ts:1–11`) has `get` and `set` but no `delete` yet: the call on line 15 needs one before it works with the real store.',
        ':::'
      ),
      read: ['src/auth/session.ts', 'src/auth/tokens.ts'],
      search: ['delete']
    }
  }
};

// --- db-migration: "Add a status column to orders"; asks what existing orders become, then migrates ------------------

const DB_C1 = 'Three statuses: pending, paid and shipped';
const DB_C2 = '`pending` as the default for new orders';
const DB_C3 = 'A migration file, not a schema push';
const DB_POINT = 'Add a status column to orders';
const DB_STEPS = [
  '1. Add an `OrderStatus` enum (pending, paid, shipped) to `prisma/schema.prisma`',
  '2. Add a `status` column to `Order`; new orders start as pending',
  '3. Write a migration that also sets the orders already there (your answer decides how)',
  '4. Apply it with `npx prisma migrate dev`'
];
const dbPlan = (head: string, marks: [string, string, string, string]): AskAnswer => ({
  md: md(head, '', ...DB_STEPS.map((s, i) => `${s} (${marks[i]}).`)), read: ['prisma/schema.prisma']
});
const DB_WHAT_CHANGED = 'What changed in prisma/schema.prisma?';
/** What its terminal prints once `prisma migrate dev` has applied the migration. */
const DB_APPLIED = 'now in sync';
const DB_PLANNED = md('- an `OrderStatus` enum with pending, paid and shipped;', '- a `status` column on `Order`, `@default(pending)`.');

const DB: AskSession = {
  phases: [
    {
      id: 'waiting',
      when: { states: ['waiting'] },
      catchUp: {
        points: [{ text: DB_POINT, status: 'in_progress', note: 'Waiting for your answer: what status existing orders get' }],
        where: 'Nothing is written yet. In `prisma/schema.prisma` it plans an `OrderStatus` enum and a `status` column, and asks what status the orders already in the database should get.',
        choices: [DB_C1, DB_C2],
        leftOpen: 'Its question: what status the orders already in the database get. Nothing was written.',
        read: ['prisma/schema.prisma']
      },
      status: {
        md: md(
          'Verdict: not-started — Waiting for your answer · 0/1', '',
          'Nothing is written yet. It needs one decision first: what status the orders already in the database get. Answer in its terminal (↑ ↓ and Enter, or 1 to 3).', '',
          ':::detail What happens after you answer',
          '1. `prisma/schema.prisma` gets the enum and the column.',
          '2. A migration adds them to the database and sets the orders already there.',
          '3. `npx prisma migrate dev` applies it.',
          ':::'
        ),
        read: ['prisma/schema.prisma']
      },
      doing: { md: md('Verdict: in-progress — Waiting for your answer', '', 'It stopped on a question: what status should the orders already in the database get, **paid**, **pending**, or a rule you type? Nothing runs until you answer.') },
      plan: dbPlan('Four steps, none done yet:', ['next', 'next', 'after your answer', 'last']),
      decide: {
        md: md(
          '**Pending is the safer pick.** It asks what the orders already in the database become when the `status` column arrives.', '',
          '- **paid** assumes every order was charged at checkout. `README.md:8` says payment is only captured when the order ships, so orders not shipped yet would be marked paid too early.',
          "- **pending** is the column's default: nothing looks paid that isn't, and shipped orders can be marked later.",
          '- **Type something** lets you give a rule, such as *paid if shipped*: it goes into the migration as a TODO.', '',
          ':::detail Why it only matters once',
          'New orders start as pending either way; your answer only decides what the orders there today become.',
          ':::'
        ),
        read: ['prisma/schema.prisma', 'README.md']
      },
      answers: {
        [DB_WHAT_CHANGED]: {
          md: md("Nothing yet: it only read `prisma/schema.prisma`. What it plans, once you answer its question:", '', DB_PLANNED, '', 'Today `Order` has three fields: `id`, `createdAt` and `total` (`prisma/schema.prisma:1–5`).'),
          read: ['prisma/schema.prisma']
        }
      }
    },
    {
      id: 'working',
      when: { states: ['running'] },
      catchUp: {
        points: [{ text: DB_POINT, status: 'in_progress', note: 'Writing the migration, then applying it' }],
        where: 'You answered its question. It is adding the enum and the column to `prisma/schema.prisma`, then writes the migration and applies it with `npx prisma migrate dev`.',
        choices: [DB_C1, DB_C2],
        leftOpen: 'The migration was being written: check `prisma/schema.prisma` and its migration before relying on them.',
        read: ['prisma/schema.prisma']
      },
      status: { md: md('Verdict: in-progress — Migrating', '', 'Your answer is in. It is changing `prisma/schema.prisma`, writing the migration that sets the orders already there, then running `npx prisma migrate dev`.') },
      doing: { md: md('Verdict: in-progress — Writing the migration', '', 'It edits `prisma/schema.prisma` and writes a migration under `prisma/migrations/`; then `npx prisma migrate dev` applies it to the database.') },
      plan: dbPlan('Four steps, under way:', ['now', 'now', 'next', 'last']),
      answers: {
        [DB_WHAT_CHANGED]: {
          md: md('It is changing it right now. What goes in:', '', DB_PLANNED, '', 'The migration that applies them comes next, in a folder of its own under `prisma/migrations/`.'),
          read: ['prisma/schema.prisma']
        }
      }
    },
    {
      // Its migration applied (its turn finished, or Esc once "in sync" was on screen): true either way.
      id: 'done',
      when: { printed: DB_APPLIED },
      catchUp: {
        points: [{ text: DB_POINT, status: 'done', at: 'turn', note: 'Migration written and applied' }],
        where: '`prisma/schema.prisma` has an `OrderStatus` enum and a `status` column, new orders start as pending, and its migration is applied: its terminal says the database is in sync.',
        choices: [DB_C1, DB_C2, DB_C3],
        leftOpen: null,
        read: ['prisma/schema.prisma']
      },
      status: {
        md: md(
          'Verdict: done — Column added and applied · 1/1', '',
          '`Order` has a `status` now (`prisma/schema.prisma:5`), typed by `OrderStatus` (`prisma/schema.prisma:8–12`). The migration set the orders already in the database as you answered, and `npx prisma migrate dev` applied it.', '',
          'Nothing left from your request. The Prisma client was generated again, so the code can read `order.status` at once.'
        ),
        read: ['prisma/schema.prisma']
      },
      doing: { md: md('Verdict: done — At its prompt', '', 'Nothing is running, and it waits for your next request. Its migration ran: the database is in sync with the schema.') },
      plan: dbPlan('All four steps done:', ['done', 'done', 'done, as you answered', 'done']),
      answers: {
        [DB_WHAT_CHANGED]: {
          md: md(
            'Two additions, nothing removed:', '',
            '- `status    OrderStatus @default(pending)` on `Order` (`prisma/schema.prisma:5`): new orders start as pending.',
            '- The enum itself, `OrderStatus`, with pending, paid and shipped (`prisma/schema.prisma:8–12`).', '',
            ':::detail And in the database',
            'Its migration under `prisma/migrations/` creates the enum type, adds the column with its default, and sets the orders that were already there as you answered.',
            ':::'
          ),
          read: ['prisma/schema.prisma']
        }
      }
    },
    {
      // Esc after the schema edit, before the migration reported: whether it reached the database isn't shown.
      id: 'interrupted',
      when: { interrupted: true, file: { rel: 'prisma/schema.prisma', has: 'OrderStatus' } },
      catchUp: {
        points: [{ text: DB_POINT, status: 'unclear', note: 'Schema changed; interrupted before the migration reported' }],
        where: 'You interrupted it before `npx prisma migrate dev` reported: `prisma/schema.prisma` has the `OrderStatus` enum and the `status` column; whether the migration reached the database, `npx prisma migrate status` tells.',
        choices: [DB_C1, DB_C2, DB_C3],
        leftOpen: 'The migration: interrupted before it reported.',
        read: ['prisma/schema.prisma']
      },
      status: {
        md: md(
          'Verdict: unclear — Schema changed, migration not reported', '',
          'The new column and enum are in `prisma/schema.prisma:5–12`. You interrupted it before `npx prisma migrate dev` reported, so whether the database has them is open: `npx prisma migrate status` tells, or ask the session to finish.'
        ),
        read: ['prisma/schema.prisma']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted it during the migration, and it waits for your next request.') },
      plan: dbPlan('Its plan, interrupted:', ['done', 'done', 'perhaps written', 'interrupted before it reported']),
      answers: {
        [DB_WHAT_CHANGED]: {
          md: md('Two additions, nothing removed: the `status` column on `Order` and the `OrderStatus` enum (`prisma/schema.prisma:5–12`).', '', 'In the database: the run that applies them was interrupted before it reported; `npx prisma migrate status` tells.'),
          read: ['prisma/schema.prisma']
        }
      }
    },
    {
      // Answered (1, 2 or a rule), then Esc before it changed anything.
      id: 'answered',
      when: { interrupted: true },
      catchUp: {
        points: [{ text: DB_POINT, status: 'unclear', note: 'You answered, then interrupted it before any change' }],
        where: 'You answered its question, then interrupted it before it changed anything: `prisma/schema.prisma` is as it was.',
        choices: [DB_C1, DB_C2],
        leftOpen: 'The status column: not added yet. Your answer is in its chat, for when it goes on.',
        read: ['prisma/schema.prisma']
      },
      status: { md: md('Verdict: not-started — Interrupted before any change · 0/1', '', 'You answered its question, then interrupted it: nothing is written yet. Ask it to go on, and it starts from your answer.') },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted it right after your answer, and it waits for your next request.') },
      plan: dbPlan('Its plan, interrupted at the start:', ['not done', 'not done', 'not done, though you answered', 'not done']),
      answers: {
        [DB_WHAT_CHANGED]: {
          md: 'Nothing yet: you interrupted it before its first edit. `Order` still has `id`, `createdAt` and `total` (`prisma/schema.prisma:1–5`).',
          read: ['prisma/schema.prisma']
        }
      }
    },
    {
      // Esc on its question (its turn finished): it left the column out.
      id: 'skipped',
      catchUp: {
        points: [{ text: DB_POINT, status: 'not_started', note: 'Left out: its question went unanswered' }],
        where: 'It left the column out for now, after its question went unanswered: `prisma/schema.prisma` is as it was.',
        choices: [DB_C1, DB_C2],
        leftOpen: 'The status column: not added. Its plan still holds whenever you want it.',
        read: ['prisma/schema.prisma']
      },
      status: { md: md('Verdict: not-started — Column left out · 0/1', '', 'You skipped its question, so it changed nothing. Ask again in the session when you know what the orders already there should become.') },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: it left the column out, and waits for your next request.') },
      plan: dbPlan('Its plan, on hold:', ['not done', 'not done', 'needs your answer', 'not done']),
      answers: {
        [DB_WHAT_CHANGED]: {
          md: 'Nothing: it only read `prisma/schema.prisma`, and left the column out when its question went unanswered. `Order` still has `id`, `createdAt` and `total` (`prisma/schema.prisma:1–5`).',
          read: ['prisma/schema.prisma']
        }
      }
    }
  ],
  answers: {
    'Why three statuses: pending, paid and shipped?': {
      md: md(
        "They follow an order's life in this store: placed (pending), paid, then shipped. The README's checkout says the same order of things, payment then shipping (`README.md:7–8`).", '',
        "It didn't add cancelled or refunded: nothing in the chat or the code handles those yet, so they would be states no code ever sets."
      ),
      read: ['README.md', 'prisma/schema.prisma'],
      search: ['cancel']
    },
    'Why pending as the default for new orders?': {
      md: md(
        "A new order hasn't been paid when its row is written, so pending is the one status that is always true at that moment. The code that takes the payment moves it on to paid.", '',
        ':::detail In the schema',
        "`@default(pending)` on the column: the database fills it in whenever an insert doesn't say.",
        ':::'
      ),
      read: ['prisma/schema.prisma']
    },
    'Why a migration file, not a schema push?': {
      md: md(
        "`prisma migrate dev` writes the change as a SQL file kept with the code, so every database (yours, a teammate's, production) gets exactly the same steps, in order. `prisma db push` would change your database only, and leave no record.", '',
        'It also needed a place for the backfill: the line that sets the orders already there lives in that migration.'
      ),
      read: ['prisma/schema.prisma']
    }
  }
};

// --- billing-tests: "Cover rounding and currencies"; two agents, a vitest run, a real bug fixed, done ~90 s in ---------

const BILL_C1 = 'Totals rounded once, after tax';
const BILL_C2 = 'Two Explore agents in the background';
const BILL_C3 = 'A test watcher left running';
const BILL_STEPS = [
  '1. Two agents look for what the tests miss: rounding edge cases, currency formats',
  '2. Run the billing tests to see what fails today',
  '3. Write a test for each case they find, and fix what fails',
  '4. Run everything again'
];
const billPlan = (head: string, marks: [string, string, string, string]): AskAnswer => ({
  md: md(head, '', ...BILL_STEPS.map((s, i) => `${s} (${marks[i]}).`)), read: ['src/billing/invoice.ts']
});
const INVOICE_HOW = 'How does invoiceTotal work?';
const INVOICE_STEPS = md(
  '`invoiceTotal(items, taxRate)` gives an invoice\'s total, tax included, to the cent:', '',
  '1. It adds up quantity × unit price over every line (`src/billing/invoice.ts:4`).',
  '2. It applies the tax and rounds once, to the cent (`src/billing/invoice.ts:5`).'
);
const INVOICE_BEFORE: AskAnswer = {
  md: md(
    INVOICE_STEPS, '',
    ':::detail Where it can go wrong',
    'Floating point: 10.015 is stored as 10.01499…, so `Math.round` sends that half down, to 10.01. A test on an x.xx5 amount would show it.',
    ':::'
  ),
  read: ['src/billing/invoice.ts'],
  search: ['Math.round']
};
const INVOICE_FIX = { rel: 'src/billing/invoice.ts', has: 'Number.EPSILON' };
const INVOICE_AFTER: AskAnswer = {
  md: md(
    INVOICE_STEPS, '',
    ':::detail The fix it made',
    '10.015 is stored as 10.01499… in floating point, so a plain `Math.round` sent halves down. Adding `Number.EPSILON` before rounding (line 5) nudges them back up: 10.015 now gives 10.02.',
    ':::'
  ),
  read: ['src/billing/invoice.ts']
};
const CURRENCIES_NOTE = 'EUR, JPY and CHF formats covered';
const CURRENCIES_DONE: AskPoint = { text: 'Cover currencies', status: 'done', at: 'turn', note: CURRENCIES_NOTE };

const BILLING: AskSession = {
  phases: [
    {
      id: 'working',
      when: { states: ['running'], file: { rel: INVOICE_FIX.rel, lacks: INVOICE_FIX.has } },
      catchUp: {
        points: [
          { text: 'Cover rounding', status: 'in_progress', note: 'An agent is listing the cases `invoiceTotal` misses' },
          { text: 'Cover currencies', status: 'in_progress', note: 'An agent is reading how amounts are formatted' }
        ],
        where: 'Two Explore agents look for the cases `invoiceTotal` gets wrong, while vitest runs the billing tests in the background. A first new test, rounds to cents, is in `tests/billing.test.ts`.',
        choices: [BILL_C1, BILL_C2],
        leftOpen: 'Both parts were under way: the agents had not reported, and the test run had not finished.',
        read: ['src/billing/invoice.ts', 'tests/billing.test.ts']
      },
      status: {
        md: md(
          'Verdict: in-progress — Tests being written · 0/2', '',
          'Both parts are under way, neither finished:', '',
          '- **Rounding**: an agent lists the cases `invoiceTotal` may get wrong (halves, refunds, many small items). One new test, *rounds to cents*, is in `tests/billing.test.ts:8–10`.',
          '- **Currencies**: another agent reads how amounts are formatted per currency.', '',
          ':::detail What runs right now',
          'Two Explore agents and `npm test -- billing`, all in the background: Background (⌘⌥B) shows each one live.',
          ':::'
        ),
        read: ['tests/billing.test.ts']
      },
      doing: { md: md('Verdict: in-progress — Exploring and testing', '', 'Its two agents read the billing code while vitest runs the tests there are. When they report, it writes the tests they suggest and fixes what fails.') },
      plan: billPlan('Four steps, the first two under way:', ['now', 'now', 'next', 'last']),
      answers: {
        [INVOICE_HOW]: INVOICE_BEFORE
      }
    },
    {
      id: 'fixing',
      when: { states: ['running'] },
      catchUp: {
        points: [{ text: 'Cover rounding', status: 'in_progress', note: 'A real bug found and fixed in `invoiceTotal`; testing again' }, { text: 'Cover currencies', status: 'done', note: CURRENCIES_NOTE }],
        where: 'The tests found a real bug: halves like 10.015 rounded down. It fixed `invoiceTotal` in `src/billing/invoice.ts:5`, and is running the tests again, with a watcher left on.',
        choices: [BILL_C1, BILL_C2, BILL_C3],
        leftOpen: 'The fix was in, but the second test run had not finished.',
        read: ['src/billing/invoice.ts']
      },
      status: { md: md('Verdict: in-progress — Almost there · 1/2', '', 'Currencies are covered. Rounding found a real bug, fixed in `src/billing/invoice.ts:5`; it is running the billing tests again to confirm.'), read: ['src/billing/invoice.ts'] },
      doing: { md: md('Verdict: in-progress — Running the tests again', '', 'It fixed `invoiceTotal` and started a test watcher (`npx vitest --watch billing`); a full run of the billing tests comes next.') },
      plan: billPlan('Four steps, the last one next:', ['done', 'done', 'done: one real bug fixed', 'now']),
      answers: { [INVOICE_HOW]: INVOICE_AFTER }
    },
    {
      id: 'done',
      when: { file: INVOICE_FIX },
      catchUp: {
        points: [{ text: 'Cover rounding', status: 'done', at: 'turn', note: 'A real bug fixed: halves round up now' }, CURRENCIES_DONE],
        where: 'Done: 14 new tests over rounding and currencies, all 16 pass, and a real bug fixed: `invoiceTotal` now rounds halves up (`src/billing/invoice.ts:5`). A test watcher keeps running.',
        choices: [BILL_C1, BILL_C2, BILL_C3],
        leftOpen: 'Only the test watcher: it keeps running until you stop it from Background.',
        read: ['src/billing/invoice.ts', 'tests/billing.test.ts']
      },
      status: {
        md: md(
          'Verdict: done — Both covered · 2/2', '',
          '14 new tests, all 16 green, and one real bug fixed on the way: halves like 10.015 rounded down, and now round up (`src/billing/invoice.ts:5`).', '',
          'Nothing left from your request. The watcher it started runs the billing tests again each time a billing file changes.'
        ),
        read: ['src/billing/invoice.ts']
      },
      doing: { md: md('Verdict: done — Finished its turn', '', 'It is at its prompt; only its test watcher runs, in the background. Background (⌘⌥B) shows it.') },
      plan: billPlan('Its plan is done:', ['done', 'done', 'done: one real bug fixed', 'done: 16 of 16']),
      answers: { [INVOICE_HOW]: INVOICE_AFTER }
    },
    {
      // Its turn over before the fix (stopped, or its Claude gone from the terminal): nothing was fixed.
      id: 'interrupted',
      catchUp: {
        points: [
          { text: 'Cover rounding', status: 'unclear', note: 'Stopped before the fix: halves like 10.015 still round down' },
          { text: 'Cover currencies', status: 'unclear', note: 'Stopped before its agent reported' }
        ],
        where: 'Its turn ended before the work did: `invoiceTotal` in `src/billing/invoice.ts` is unchanged, and only one new test, rounds to cents, is in.',
        choices: [BILL_C1, BILL_C2],
        leftOpen: 'The rounding fix and the currency tests: neither was finished.',
        read: ['src/billing/invoice.ts', 'tests/billing.test.ts']
      },
      status: {
        md: md(
          'Verdict: not-started — Stopped before the fix · 0/2', '',
          'One new test is in (`tests/billing.test.ts:8–10`), but the turn ended before the agents reported and before any fix: `src/billing/invoice.ts:5` still sends halves like 10.015 down.'
        ),
        read: ['src/billing/invoice.ts', 'tests/billing.test.ts']
      },
      doing: { md: md('Verdict: done — Idle', '', 'Nothing runs in its turn any more: it ended before the work did, and waits for your next request.') },
      plan: billPlan('Its plan, cut short:', ['started', 'started', 'not done', 'not done']),
      answers: { [INVOICE_HOW]: INVOICE_BEFORE }
    }
  ],
  answers: {
    'Why totals rounded once, after tax?': {
      md: md(
        'Rounding each line, then adding the lines up, drifts: ten lines of 0.105 round to 1.10 one by one, while the exact total is 1.05. Rounding once, at the end (`src/billing/invoice.ts:5`), keeps the total as close as cents allow.', '',
        "The agent that read the code found it already worked this way; the new tests pin it, so a later change can't quietly move the rounding."
      ),
      read: ['src/billing/invoice.ts'],
      search: ['Math.round']
    },
    'Why two Explore agents in the background?': {
      md: md(
        "Rounding and currency formats don't depend on each other, so it sent one agent on each and kept working while they read. Explore agents only read the code: they change nothing.", '',
        'They report to the session when they finish; until then Background (⌘⌥B) shows what each one reads.'
      )
    },
    'Why a test watcher left running?': {
      md: md(
        'So the billing tests run again by themselves whenever a billing file changes, after this turn too. It started `npx vitest --watch billing` as a persistent watcher: Atelier lists it in the session\'s Background but never counts it as work, so the session still shows as done.', '',
        'Stop it from Background (⌘⌥B) when you no longer want it.'
      )
    }
  }
};

// --- onboarding-copy: "Make the welcome page friendlier"; done ----------------------------------------------------------

const ONB_C1 = "A “Continue shopping” link you didn't ask for";
const ONB_C2 = 'The same greeting for new customers';

const ONBOARDING: AskSession = {
  phases: [
    {
      id: 'done',
      catchUp: {
        points: [{ text: 'Make the welcome page friendlier', status: 'done', at: 'turn', note: 'A warmer greeting, and a link back to the cart' }],
        where: 'Done, and waiting for your next request. `src/pages/welcome.tsx` greets customers by name and links them back to their cart.',
        choices: [ONB_C1, ONB_C2],
        leftOpen: null,
        read: ['src/pages/welcome.tsx']
      },
      status: {
        md: md(
          'Verdict: done — Finished · 1/1', '',
          'The welcome page is friendlier: a warmer heading, a reassuring line about the cart, and a link back to it (`src/pages/welcome.tsx:4–6`).', '',
          'Nothing left from your request. One thing you may want to check: the new heading, *Good to see you*, reads oddly on a first visit.'
        ),
        read: ['src/pages/welcome.tsx']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running. It finished the welcome page and waits for your next request: type one in its terminal.') },
      plan: {
        md: md('A short one, all done:', '', '1. Read the welcome page (`src/pages/welcome.tsx`).', '2. Warm up the heading and the line about the cart.', '3. Add a link back to the cart.'),
        read: ['src/pages/welcome.tsx']
      }
    }
  ],
  answers: {
    'What changed in src/pages/welcome.tsx?': {
      md: md(
        'Three lines of `Welcome` (`src/pages/welcome.tsx:4–6`):', '',
        '- The heading: *Welcome to Acme, {name}* became *Good to see you, {name}*.',
        '- The line under it: *Your cart is ready when you are.* became *Your cart is right where you left it.*',
        '- New: a *Continue shopping* link to `/cart`.'
      ),
      read: ['src/pages/welcome.tsx']
    },
    "Why a “Continue shopping” link you didn't ask for?": {
      md: md(
        "You asked for a friendlier page. It wrote *Your cart is right where you left it*, and a promise you can't act on is a dead end: the link (`src/pages/welcome.tsx:6`) makes it one click.", '',
        'It is the one addition beyond rewording: worth a look if the page should stay text only.'
      ),
      read: ['src/pages/welcome.tsx']
    },
    'Why the same greeting for new customers?': {
      md: md(
        "`Welcome` gets only a `name` (`src/pages/welcome.tsx:1`): it can't tell a returning customer from a new one, so everyone gets *Good to see you*.", '',
        ':::detail If it matters',
        'A flag such as `returning`, passed by the page that renders `Welcome`, would let a first visit keep a plain *Welcome*.',
        ':::'
      ),
      read: ['src/pages/welcome.tsx']
    }
  }
};

// --- docs: "Document the checkout flow"; keeps working, reading the code it documents, with a cron ------------------

const DOCS_C1 = 'The docs in `README.md`, not a docs folder';
const DOCS_C2 = 'A check of the preview deploy every 30 minutes';

const DOCS: AskSession = {
  phases: [
    {
      id: 'working',
      when: { states: ['running'] },
      catchUp: {
        points: [{ text: 'Document the checkout flow', status: 'in_progress', note: 'A first draft is in `README.md`; checking it against the code' }],
        where: 'A first Checkout section is in `README.md`. Now it reads the code the checkout goes through, to check each step it wrote; every 30 minutes it also checks the preview deploy.',
        choices: [DOCS_C1, DOCS_C2],
        leftOpen: 'The Checkout section is a first draft: it was still checking it against the code.',
        read: ['README.md']
      },
      status: {
        md: md(
          'Verdict: in-progress — Draft written, being checked', '',
          'The section is in `README.md:5–8`: two steps, the stock check, then payment. Now it reads the code those steps go through (sessions, invoices, the welcome page) to make sure the README says what the code does.', '',
          ':::detail Something to check in the draft',
          '`README.md:8` says payment is captured when the order ships. Nothing in the code it read so far takes a payment: the project has no payment module yet, so that line describes the plan, not the code.',
          ':::'
        ),
        read: ['README.md', 'src/billing/invoice.ts']
      },
      doing: { md: md('Verdict: in-progress — Reading the code', '', 'It reads the files the checkout goes through, one at a time, to check the section it wrote: sessions first, then invoices, then the welcome page.') },
      plan: {
        md: md('1. Write a Checkout section in `README.md` (done).', '2. Check each step against the code: sessions, invoices, the welcome page (now).', '3. Fix the section wherever the code says otherwise (next).'),
        read: ['README.md']
      }
    },
    {
      // Esc while it reads the code (the engine's interrupt): the draft stays, unchecked.
      id: 'stopped',
      catchUp: {
        points: [{ text: 'Document the checkout flow', status: 'unclear', note: 'A first draft is in `README.md`, not checked against the code' }],
        where: 'You interrupted it: a first Checkout section is in `README.md`, but it stopped before checking it against the code.',
        choices: [DOCS_C1, DOCS_C2],
        leftOpen: 'Checking the draft against the code: not done.',
        read: ['README.md']
      },
      status: {
        md: md(
          'Verdict: unclear — Draft written, not checked', '',
          'The section is in `README.md:5–8`; it stopped before checking it against the code. One line worth checking yourself: `README.md:8` says payment is captured when the order ships, and the project has no payment module yet.'
        ),
        read: ['README.md']
      },
      doing: { md: md('Verdict: done — Idle at its prompt', '', 'Nothing is running: you interrupted it while it read the code, and it waits for your next request.') },
      plan: {
        md: md('1. Write a Checkout section in `README.md` (done).', '2. Check each step against the code (interrupted).', '3. Fix the section wherever the code says otherwise (not done).'),
        read: ['README.md']
      }
    }
  ],
  answers: {
    'What changed in README.md?': {
      md: md(
        "One new section, **Checkout** (`README.md:5–8`), under the store's one-line description:", '',
        '1. The cart is validated against current stock.',
        '2. Payment is authorised, then captured when the order ships.', '',
        'The rest of the README is as it was.'
      ),
      read: ['README.md']
    },
    'Why the docs in README.md, not a docs folder?': {
      md: 'The project has no docs folder, and the README is the page everyone opens first (`README.md:1–3`). A short flow fits there; it can move to a page of its own once it grows.',
      read: ['README.md']
    },
    'Why a check of the preview deploy every 30 minutes?': {
      md: md(
        'It scheduled that itself, as a loop of the session: every 30 minutes Claude Code sends it *check the preview deploy*, so it notices if the checkout it documents breaks on the preview.', '',
        "Atelier shows it in the session's Background (⌘⌥B), with the time of its next run."
      )
    }
  }
};

export const ASK_SCRIPT: AskScript = {
  sessions: { 'auth-refactor': AUTH, 'billing-tests': BILLING, 'onboarding-copy': ONBOARDING, 'db-migration': DB, docs: DOCS },
  visitor: {
    where: {
      waiting: 'It is on your latest prompt, and waits for your answer in its terminal ({wait}).',
      working: 'It is working on your latest prompt, reading the code before it proposes a change.',
      done: 'It finished your latest prompt; whatever it changed is in Changes, under its name.',
      stopped: 'Stopped: you interrupted it on your latest prompt. Anything it had already changed is in Changes, under its name.'
    },
    status: {
      waiting: { md: md('Verdict: in-progress — Waiting for you', '', 'On “{prompt}”, it stopped to ask before going on ({wait}). The menu in its terminal shows exactly what it wants to do: answer it there.') },
      working: { md: md('Verdict: in-progress — Working on your prompt', '', '“{prompt}”: it is reading the code it needs first. An edit will ask you before it happens.') },
      done: { md: md('Verdict: done — Finished your prompt', '', '“{prompt}” is done. What it changed is in Changes, under its name; its terminal has its last words.') },
      stopped: { md: md('Verdict: unclear — Stopped', '', 'Stopped: “{prompt}” — you interrupted it before it finished. Anything it had already changed is in Changes, under its name; its terminal shows how far it got.') }
    },
    plan: {
      md: md(
        'In this demo a new prompt plays a short script: Claude reads two files, proposes one edit, and asks before making it.', '',
        "In Atelier, Ask explains the session's real plan from its chat and its code, read-only."
      )
    },
    decide: {
      md: md(
        '**Look at the menu first.** It asks before one edit, and the menu in its terminal shows the change with its diff.', '',
        '- **1, Yes**: it makes the edit; you will see it in Changes, under its name.',
        '- **3, No**: it leaves the file as it is.'
      )
    }
  },
  nothingAsked: {
    where: 'Nothing asked yet',
    status: { md: md('Verdict: not-started — Nothing asked yet', '', 'This session has no prompt yet. Type one in its terminal; Ask follows what it does.') }
  },
  notAsking: { md: "Nothing to decide: it isn't asking you anything right now. When it does, an amber card shows here with what it asks." },
  fallback: {
    md: md(
      "In this demo Ask answers from a script; in Atelier it reads the session's chat and code, read-only.", '',
      'The suggested questions have scripted answers: try **Catch me up**, then the questions under it.'
    )
  }
};
