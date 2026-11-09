// The live demo's Claude beats: what each scripted session does next, as data. A beat is a set of
// named segments; a segment is a list of steps — Claude Code's hook events (the app's reducers turn them into the
// session's states at build time, src/demo/compile/beats.ts), transcript text, tool output, edits to the project, menus
// that wait for the visitor (their answers route to other segments) and waits. Pure data plus the small builders that
// write the repetitive parts (a Read, an Edit, a Bash run) the way Claude Code draws them.
import type { BeatAsk, BeatStep, BeatWrite } from '../engine/beats-types';
import type { PermissionView } from '../engine/claude-screen';
import type { ScenarioName } from './scenarios';

/** A hook payload as Claude Code sends it; `file_path` relative to the project (made absolute when compiled). */
export type Hook = Record<string, unknown>;
/** An authored step: a hook event, or a step the runtime plays as it is. */
export type SourceStep = { hook: Hook } | Exclude<BeatStep, { k: 'session' }>;
export interface SourceBeat { start: string; segments: Record<string, SourceStep[]> }

const E = '\u001b';
const DIM = `${E}[2m`;
const RST = `${E}[0m`;
const GREEN = `${E}[32m`;
const RED = `${E}[31m`;
const YELLOW = `${E}[33m`;
const DOT = `${E}[1m●${RST}`;

// Builders: each returns the steps for one thing Claude does, drawn as Claude Code draws it.

const hook = (hook_event_name: string, rest: Hook = {}): SourceStep => ({ hook: { hook_event_name, ...rest } });
const tool = (name: string, arg: string) => `${DOT} ${name}(${arg})`;
const wait = (ms: number): SourceStep => ({ k: 'wait', ms });
const spinner = (text: string): SourceStep => ({ k: 'spinner', text });
const cost = (usd: number, added: number, removed: number, context: number): SourceStep => ({ k: 'cost', usd, added, removed, context });

/** Claude's text: a ● then the lines, indented under it. */
export const answer = (...lines: string[]): SourceStep => ({ k: 'say', lines: ['', `${DOT} ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `  ${l}`)] });

/** A tool's result line under it (dim). */
const result = (text: string) => `  ${DIM}⎿  ${text}${RST}`;
/** An edit's summary: lines added and removed, then a note (Claude Code's look in the scenarios). */
const stat = (added: number, removed: number, note: string) =>
  `  ${DIM}⎿  ${RST}${GREEN}+${added}${RST}${removed ? ` ${RED}-${removed}${RST}` : ''}${DIM}  ${note}${RST}`;

/** Read: the hook pair around it, the tool line and how many lines it read. */
export function read(file: string, lines: number): SourceStep[] {
  const input = { file_path: file };
  return [hook('PreToolUse', { tool_name: 'Read', tool_input: input }), { k: 'say', lines: ['', tool('Read', file)] }, wait(450), { k: 'out', lines: [result(`Read ${lines} lines`)], every: 0 }, hook('PostToolUse', { tool_name: 'Read', tool_input: input })];
}

export function grep(pattern: string, found: string): SourceStep[] {
  const input = { pattern, path: 'src' };
  return [hook('PreToolUse', { tool_name: 'Grep', tool_input: input }), { k: 'say', lines: ['', tool('Search', `pattern: "${pattern}"`)] }, wait(400), { k: 'out', lines: [result(found)], every: 0 }, hook('PostToolUse', { tool_name: 'Grep', tool_input: input })];
}

/** An edit Claude makes on its own (no permission asked): Update(file), the write, its summary. */
export function edit(file: string, write: Omit<BeatWrite, 'file'>, s: { added: number; removed: number; note: string }, tool_name = 'Edit'): SourceStep[] {
  const input = { file_path: file };
  return [
    hook('PreToolUse', { tool_name, tool_input: input }),
    { k: 'say', lines: ['', tool(tool_name === 'Write' ? 'Write' : 'Update', file)] },
    wait(500),
    { k: 'write', write: { file, ...write } },
    hook('PostToolUse', { tool_name, tool_input: input }),
    { k: 'out', lines: [stat(s.added, s.removed, s.note)], every: 0 },
    cost(0.06, s.added, s.removed, 1)
  ];
}

/** The choices Claude Code offers for an edit. */
export const EDIT_CHOICES = ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No, and tell Claude what to do differently (esc)'];

/**
 * An edit that asks first: the hook pair that puts the session in "waiting", then the menu (its diff shown). Yes (1, 2)
 * goes to `apply`, No or Esc to `decline`.
 */
export function askEdit(file: string, diff: string[], routes: { apply: string; decline: string }): SourceStep[] {
  const input = { file_path: file };
  const view: PermissionView = { title: 'Edit file', detail: [file, '', ...diff], question: `Do you want to make this edit to ${file}?`, choices: EDIT_CHOICES };
  const ask: BeatAsk = { kind: 'permission', view, routes: [routes.apply, routes.apply, routes.decline], cancel: routes.decline };
  return [hook('PreToolUse', { tool_name: 'Edit', tool_input: input }), hook('PermissionRequest', { tool_name: 'Edit', tool_input: input }), { k: 'ask', ask }];
}

/** The edit asked for, applied: the write, the PostToolUse, its summary. */
export function applyEdit(file: string, write: Omit<BeatWrite, 'file'>, s: { added: number; removed: number; note: string }): SourceStep[] {
  const input = { file_path: file };
  return [
    spinner('Editing…'),
    { k: 'say', lines: ['', tool('Update', file)] },
    wait(400),
    { k: 'write', write: { file, ...write } },
    hook('PostToolUse', { tool_name: 'Edit', tool_input: input }),
    { k: 'out', lines: [stat(s.added, s.removed, s.note)], every: 0 },
    cost(0.05, s.added, s.removed, 1)
  ];
}

/** A Bash run: the tool line, its output streamed under it (⎿ on the first line), the PostToolUse. */
export function bash(command: string, output: string[], every = 160): SourceStep[] {
  const input = { command };
  return [
    hook('PreToolUse', { tool_name: 'Bash', tool_input: input }),
    { k: 'say', lines: ['', tool('Bash', command)] },
    { k: 'out', lines: output.map((l, i) => (i === 0 ? `  ${DIM}⎿${RST}  ${l}` : `     ${l}`)), every },
    hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_response: { stdout: '', stderr: '', interrupted: false } })
  ];
}

/** The turn ends: Stop (the app chimes and lists it in the inbox by itself), the prompt is back. */
const stop = (rest: Hook = {}): SourceStep[] => [hook('Stop', rest), { k: 'prompt' }];

/** The visitor's prompt starts a turn (its text is the runtime's: {prompt}). */
const submit = (): SourceStep => hook('UserPromptSubmit', { prompt: '{prompt}' });

const pass = (s: string) => `${GREEN}✓${RST} ${s}`;
const fail = (s: string) => `${RED}×${RST} ${s}`;

// auth-refactor: waits on "Run npm test -- auth?". Yes: the run shows the skew bug, Claude fixes session.ts (attributed,
// in Changes), runs the tests again and is done. No or Esc: it says so and is done.

const AUTH_SKEW: [string, string] = ['entry.expiresAt - SKEW_MS < now', 'entry.expiresAt + SKEW_MS < now'];

const AUTH_REFACTOR: SourceBeat = {
  start: 'ask',
  segments: {
    ask: [{ k: 'ask', ask: { kind: 'permission', command: 'npm test -- auth', routes: ['run', 'run', 'reject'], cancel: 'reject' } }],
    run: [
      spinner('Running…'),
      ...bash('npm test -- auth', [
        '> acme-store@0.1.0 test', '> vitest run auth', '',
        ` ${YELLOW}RUN${RST}  v3.2.4`, '',
        ` ${pass('tests/auth/tokens.test.ts (3)')}`,
        ` ${YELLOW}❯${RST} tests/auth/session.test.ts (4)`,
        `   ${pass('reads a live session')}`,
        `   ${pass('drops an expired token')}`,
        `   ${fail('accepts a token inside the clock skew')}`,
        `     ${RED}→ expected null to deeply equal { userId: 'u1' }${RST}`,
        `   ${pass('returns null for an unknown token')}`, '',
        ` Test Files  ${RED}1 failed${RST} | ${GREEN}1 passed${RST} (2)`,
        `      Tests  ${RED}1 failed${RST} | ${GREEN}6 passed${RST} (7)`
      ], 170),
      cost(0.04, 0, 0, 2),
      spinner('Thinking…'),
      wait(900),
      answer('One test fails: the skew is applied the wrong', 'way round, so a token 10 s past expiry is', 'refused. Fixing the comparison.'),
      spinner('Editing…'),
      ...edit('src/auth/session.ts', { replace: [AUTH_SKEW] }, { added: 1, removed: 1, note: "skew in the token's favour" }),
      spinner('Running…'),
      ...bash('npm test -- auth', [` Test Files  ${GREEN}2 passed${RST} (2)`, `      Tests  ${GREEN}7 passed${RST} (7)`], 220),
      wait(500),
      answer('Fixed. Tokens inside the 30 s clock skew are', 'accepted again, and all 7 auth tests pass.'),
      ...stop()
    ],
    reject: [
      spinner('Thinking…'),
      wait(600),
      answer("OK, I won't run it. The tests are ready when", 'you are: npm test -- auth.'),
      ...stop()
    ]
  }
};

// db-migration: a question with options. Each answer continues its own way: the schema gets the enum and the column,
// a migration is written (what existing orders become depends on the answer), prisma migrates, done.

const SCHEMA_EDIT: [string, string] = ['  total     Decimal\n}\n', '  total     Decimal\n  status    OrderStatus @default(pending)\n}\n\nenum OrderStatus {\n  pending\n  paid\n  shipped\n}\n'];
const MIGRATION = 'prisma/migrations/20261015094500_order_status/migration.sql';
const migrationSql = (existing: string) =>
  `-- CreateEnum\nCREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid', 'shipped');\n\n-- AlterTable\nALTER TABLE "Order" ADD COLUMN "status" "OrderStatus" NOT NULL DEFAULT 'pending';\n${existing}`;

function migrate(existing: string, summary: string[]): SourceStep[] {
  return [
    spinner('Migrating…'),
    ...edit('prisma/schema.prisma', { replace: [SCHEMA_EDIT] }, { added: 7, removed: 0, note: 'OrderStatus enum, status column' }),
    ...edit(MIGRATION, { content: migrationSql(existing) }, { added: migrationSql(existing).split('\n').length - 1, removed: 0, note: 'new migration' }, 'Write'),
    ...bash('npx prisma migrate dev --name order_status', [
      'Applying migration `20261015094500_order_status`', '',
      'Your database is now in sync with your schema.', '',
      `${GREEN}✔${RST} Generated Prisma Client (v6.1.0) in 92ms`
    ], 240),
    wait(400),
    answer(...summary),
    ...stop()
  ];
}

const answered = (): SourceStep => hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } });

const DB_MIGRATION: SourceBeat = {
  start: 'ask',
  segments: {
    ask: [{ k: 'ask', ask: { kind: 'question', options: ['paid', 'pending', 'Type something'], routes: ['paid', 'pending', 'typed'], cancel: 'skip', typed: 2 } }],
    paid: [answered(), wait(500), answer('Existing orders become paid: every one of them', 'was charged at checkout.'),
      ...migrate(`\n-- Existing orders were all paid at checkout\nUPDATE "Order" SET "status" = 'paid';\n`, ['Done. Orders have a status now: new ones start', 'as pending, and the 38 existing orders are', 'marked paid.'])],
    pending: [answered(), wait(500), answer("Existing orders keep the column's default,", 'pending.'),
      ...migrate('', ['Done. Orders have a status now, pending by', 'default, existing orders included.'])],
    typed: [answered(), wait(500), answer('Noted: “{answer}”. Existing orders start as', "pending; your rule is a TODO in the migration."),
      ...migrate('\n-- TODO for existing orders: {answer}\n', ['Done. Orders have a status now; the rule for', 'existing orders is waiting in the migration.'])],
    skip: [answered(), spinner('Thinking…'), wait(600), answer("OK, I'll leave the column out for now."), ...stop()]
  }
};

// billing-tests: keeps working from the start. Its two background agents and the vitest shell go on (their feeds:
// BILLING_FEEDS); the agents report, the shell's one failure leads to a fix in invoice.ts, then Claude leaves a test
// watcher running (BILLING_WATCH), a second run passes, and it is done about 90 s in, so ⌘J has something new. The
// watcher outlives the turn, as Claude Code's persistent monitors do: Background always has something live.

/** When each background item of billing-tests moves on (ms from the demo's start) and how its feed starts. */
export const BILLING_FEEDS = {
  /** a1, rounding edge cases (6 steps): 3 shown at start, the others then; done at 52 s. */
  a1: { shown: 3, times: [8_000, 21_000, 36_000], ends: 52_000 },
  /** a2, currency formats (3 steps): 1 shown, then 2; done at 42 s. */
  a2: { shown: 1, times: [12_000, 29_000], ends: 42_000 },
  /** The vitest shell: its first lines at start, the rest until 50 s, exit 1 (one failure). */
  b7k2m9q4x: { shown: 12, until: 50_000, exit: 1 }
} as const;

/**
 * The test watcher billing-tests starts after its fix and leaves running: a persistent Monitor (Claude Code's Monitor
 * tool), so the app lists it as a watcher, never as work — the session is done all the same. Its feed: the first run,
 * then a rerun each time a file the billing tests import changes (the runtime appends `rerun`, {file} filled in). No
 * blank lines: each line of a monitor is an event the inspector lists.
 */
export const BILLING_WATCH = {
  id: 'm3v8w2k6p', description: 'Watch billing tests', command: 'npx vitest --watch billing',
  /** When it starts, ms from the demo's start (the beat waits for it: the feed starts with it). */
  at: 58_000,
  firstRun: [
    ' DEV  v3.2.4',
    ' ✓ tests/billing.test.ts (2)',
    ' ✓ tests/billing/currency.test.ts (4)',
    ' ✓ tests/billing/rounding.test.ts (4)',
    ' ✓ tests/billing/discounts.test.ts (3)',
    ' ✓ tests/billing/tax.test.ts (3)',
    ' Test Files  5 passed (5)',
    '      Tests  16 passed (16)',
    ' PASS  Waiting for file changes...',
    '       press h to show help, press q to quit'
  ],
  /** Files the billing tests import: vitest reruns only for those. */
  match: '^(?:src/billing/|tests/billing)',
  rerun: [
    ' RERUN  {file}',
    ' ✓ tests/billing.test.ts (2)',
    ' ✓ tests/billing/rounding.test.ts (4)',
    ' Test Files  2 passed (2)',
    '      Tests  6 passed (6)',
    ' PASS  Waiting for file changes...'
  ]
} as const;
/** The watcher as Claude Code lists it in a Stop's `background_tasks` (still running). */
const WATCH_TASK = { id: BILLING_WATCH.id, type: 'monitor', description: BILLING_WATCH.description, command: BILLING_WATCH.command, status: 'running' };

/** The vitest shell's output after the scenario's lines (the scenario stops at the tax file's first test). */
export const BILLING_SHELL_TAIL = [
  '   ✓ exempts gift cards',
  '   ✓ rounds tax per invoice',
  '',
  ' Test Files  1 failed | 4 passed (5)',
  '      Tests  1 failed | 15 passed (16)',
  '   Start at  09:41:07',
  '   Duration  1.84s (transform 61ms, setup 0ms, collect 212ms, tests 38ms)'
];

const INVOICE_ROUNDING: [string, string] = ['Math.round(net * (1 + taxRate) * 100) / 100', 'Math.round((net * (1 + taxRate) + Number.EPSILON) * 100) / 100'];

const BILLING_TESTS: SourceBeat = {
  start: 'run',
  segments: {
    run: [
      { k: 'until', ms: BILLING_FEEDS.a2.ends },
      hook('SubagentStop', { agent_id: 'a2', agent_type: 'Explore' }),
      { k: 'say', lines: ['', tool('Agent', 'currency formats'), result('Done (3 tool uses · 4.1k tokens · 41s)')] },
      { k: 'until', ms: BILLING_FEEDS.a1.ends },
      // The last subagent stops; its snapshot no longer lists the vitest shell, which ended at 50 s.
      hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', background_tasks: [] }),
      { k: 'say', lines: ['', tool('Agent', 'rounding edge cases'), result('Done (6 tool uses · 9.8k tokens · 52s)')] },
      wait(1200),
      answer('15 of 16 pass. x.xx5 rounds down: 10.015 is', '10.01499… in floating point. Fixing', 'invoiceTotal.'),
      ...edit('src/billing/invoice.ts', { replace: [INVOICE_ROUNDING] }, { added: 1, removed: 1, note: 'halves round up' }),
      { k: 'until', ms: BILLING_WATCH.at },
      hook('PostToolUse', {
        tool_name: 'Monitor', tool_input: { description: BILLING_WATCH.description, command: BILLING_WATCH.command, persistent: true },
        tool_response: { taskId: BILLING_WATCH.id, persistent: true }
      }),
      { k: 'say', lines: ['', tool('Monitor', BILLING_WATCH.description), result(`Watching ${BILLING_WATCH.command} (persistent)`)] },
      { k: 'until', ms: 76_000 },
      ...bash('npm test -- billing', [` Test Files  ${GREEN}5 passed${RST} (5)`, `      Tests  ${GREEN}16 passed${RST} (16)`], 260),
      { k: 'until', ms: 88_000 },
      answer('Done: 14 new tests over rounding and', 'currencies, and one real bug fixed in', 'invoiceTotal (halves now round up).', 'The tests keep watching in the background.'),
      ...stop({ background_tasks: [WATCH_TASK] })
    ]
  }
};

// docs: keeps working (its cron counts down on its own): it reads the code it documents, slowly.

const DOCS: SourceBeat = {
  start: 'run',
  segments: {
    run: [
      { k: 'until', ms: 24_000 }, ...read('src/auth/session.ts', 19),
      { k: 'until', ms: 47_000 }, ...read('src/billing/invoice.ts', 6),
      { k: 'until', ms: 71_000 }, ...grep('checkout', 'Found 2 files'),
      { k: 'until', ms: 95_000 }, ...read('src/pages/welcome.tsx', 9)
    ]
  }
};

// A free prompt (any idle or done session, or a new one): Claude reads two files, proposes a small edit, asks, edits.
// Three of them, in turn; the demo does not pretend to understand the prompt (honesty is in the demo's chrome).

function generic(o: { reads: [string, number][]; say: string[]; file: string; write: Omit<BeatWrite, 'file'>; diff: string[]; stat: { added: number; removed: number; note: string }; done: string[] }): SourceBeat {
  return {
    start: 'look',
    segments: {
      look: [submit(), spinner('Reading…'), wait(700), ...o.reads.flatMap(([f, n]) => read(f, n)), spinner('Thinking…'), wait(800), answer(...o.say), ...askEdit(o.file, o.diff, { apply: 'apply', decline: 'decline' })],
      apply: [...applyEdit(o.file, o.write, o.stat), wait(400), answer(...o.done), ...stop()],
      decline: [spinner('Thinking…'), wait(500), answer(`OK, I left ${o.file} as it is.`), ...stop()]
    }
  };
}

const TOKENS_DELETE: [string, string] = ['  set(token: string, userId: string, ttlMs: number) {', '  delete(token: string) {\n    this.entries.delete(token);\n  }\n\n  set(token: string, userId: string, ttlMs: number) {'];
const NEGATIVE_GUARD: [string, string] = ['export function invoiceTotal(items: LineItem[], taxRate: number): number {\n', "export function invoiceTotal(items: LineItem[], taxRate: number): number {\n  if (items.some((i) => i.quantity < 0)) throw new RangeError('negative quantity');\n"];
const README_DEV = '\n## Development\n\n- `npm run dev`: the store on localhost:5173\n- `npm test`: the tests (vitest)\n';

const add = (l: string) => `${GREEN}+ ${l}${RST}`;
const del = (l: string) => `${RED}- ${l}${RST}`;

const GENERIC_TOKENS = generic({
  reads: [['src/auth/tokens.ts', 11], ['src/auth/session.ts', 19]],
  say: ['session.ts calls store.delete(), but TokenStore', 'has no delete() yet. Adding it.'],
  file: 'src/auth/tokens.ts', write: { replace: [TOKENS_DELETE] },
  diff: [add('delete(token: string) {'), add('  this.entries.delete(token);'), add('}')],
  stat: { added: 4, removed: 0, note: 'TokenStore.delete' },
  done: ['Added TokenStore.delete(), so expired tokens', 'are dropped from the store.']
});

const GENERIC_INVOICE = generic({
  reads: [['src/billing/invoice.ts', 6], ['tests/billing.test.ts', 10]],
  say: ['invoiceTotal accepts negative quantities and', 'returns a negative total. It should refuse them.'],
  file: 'src/billing/invoice.ts', write: { replace: [NEGATIVE_GUARD] },
  diff: [add("if (items.some((i) => i.quantity < 0)) throw new RangeError('negative quantity');")],
  stat: { added: 1, removed: 0, note: 'refuse negative quantities' },
  done: ['invoiceTotal now throws a RangeError on a', 'negative quantity.']
});

const GENERIC_README = generic({
  reads: [['package.json', 5], ['README.md', 8]],
  say: ["The README doesn't say how to run the store.", 'Adding a short Development section.'],
  file: 'README.md', write: { append: README_DEV },
  diff: [add('## Development'), add('- `npm run dev`: the store on localhost:5173'), add('- `npm test`: the tests (vitest)')],
  stat: { added: 5, removed: 0, note: 'Development section' },
  done: ['Added a Development section to the README.']
});

// Diagnosis beats for "send to session": the worker's crash from Docker, a failed BullMQ job from Redis.

const WORKER_REDIS: [string, string] = ['      REDIS_URL: redis://127.0.0.1:6379\n', '      REDIS_URL: redis://redis:6379\n'];
const WORKER_SMTP: [string, string] = ['    environment:\n', '    environment:\n      SMTP_URL: smtp://mailpit:1025\n'];

const DIAGNOSE_WORKER: SourceBeat = {
  start: 'look',
  segments: {
    look: [
      submit(), spinner('Investigating…'), wait(700),
      ...read('compose.yml', 25),
      spinner('Thinking…'), wait(900),
      answer('The worker connects to 127.0.0.1:6379. Inside', 'its container that address is the worker', 'itself, not the redis service: every start is', 'refused, and after 3 restarts Docker gives up.'),
      answer('REDIS_URL should name the service: redis:6379.'),
      ...askEdit('compose.yml', [del('REDIS_URL: redis://127.0.0.1:6379'), add('REDIS_URL: redis://redis:6379')], { apply: 'apply', decline: 'decline' })
    ],
    apply: [...applyEdit('compose.yml', { replace: [WORKER_REDIS] }, { added: 1, removed: 1, note: 'redis by service name' }), wait(400),
      answer('Fixed. Start it again with', '`docker compose up -d worker`.'), ...stop()],
    decline: [spinner('Thinking…'), wait(500), answer('OK, I left compose.yml as it is.'), ...stop()]
  }
};

const DIAGNOSE_JOB: SourceBeat = {
  start: 'look',
  segments: {
    look: [
      submit(), spinner('Investigating…'), wait(700),
      ...grep('SMTP_URL', 'Found 1 file'),
      ...read('compose.yml', 25),
      spinner('Thinking…'), wait(900),
      answer('send-receipt mails through SMTP_URL, which', 'falls back to 127.0.0.1:1025. In Docker the', 'mail server is the mailpit service, and', "compose.yml gives the worker no SMTP_URL:", 'every attempt is refused, 3 times per job.'),
      ...askEdit('compose.yml', [add('SMTP_URL: smtp://mailpit:1025')], { apply: 'apply', decline: 'decline' })
    ],
    apply: [...applyEdit('compose.yml', { replace: [WORKER_SMTP] }, { added: 1, removed: 0, note: 'mail through mailpit' }), wait(400),
      answer('Added. Once the worker restarts, retry the', 'failed jobs from the Redis view.'), ...stop()],
    decline: [spinner('Thinking…'), wait(500), answer('OK, I left compose.yml as it is.'), ...stop()]
  }
};

export type BeatName = 'auth-refactor' | 'db-migration' | 'billing-tests' | 'docs' | 'generic-tokens' | 'generic-invoice' | 'generic-readme' | 'diagnose-worker' | 'diagnose-job';

export const BEATS: Record<BeatName, SourceBeat> = {
  'auth-refactor': AUTH_REFACTOR,
  'db-migration': DB_MIGRATION,
  'billing-tests': BILLING_TESTS,
  docs: DOCS,
  'generic-tokens': GENERIC_TOKENS,
  'generic-invoice': GENERIC_INVOICE,
  'generic-readme': GENERIC_README,
  'diagnose-worker': DIAGNOSE_WORKER,
  'diagnose-job': DIAGNOSE_JOB
};

/** What each scripted session plays: `auto` beats start with the demo, the others wait for the visitor. */
export const SESSION_BEATS: Partial<Record<ScenarioName, { beat: BeatName; auto: boolean }>> = {
  'auth-refactor': { beat: 'auth-refactor', auto: false },
  'db-migration': { beat: 'db-migration', auto: false },
  'billing-tests': { beat: 'billing-tests', auto: true },
  docs: { beat: 'docs', auto: true }
};

/** Free prompts play these in turn. */
export const GENERIC_BEATS: BeatName[] = ['generic-tokens', 'generic-invoice', 'generic-readme'];

/** A new session's screen: Claude Code's welcome box, for a session started in `cwd`. */
export function welcome(cwd: string): string[] {
  const PINK = `${E}[38;5;211m`;
  const inner = Math.max(46, cwd.length + 10);
  const width = (s: string) => [...s.replace(/\u001b\[[0-9;]*m/g, '')].length;
  const row = (s: string) => `${PINK}│${RST}${s}${' '.repeat(Math.max(0, inner - width(s)))}${PINK}│${RST}`;
  return [
    `${PINK}╭${'─'.repeat(inner)}╮${RST}`,
    row(` ${PINK}✻${RST} Welcome to ${E}[1mClaude Code${RST}!`),
    row(''),
    row(`   ${DIM}/help for help, /status for your setup${RST}`),
    row(''),
    row(`   ${DIM}cwd: ${cwd}${RST}`),
    `${PINK}╰${'─'.repeat(inner)}╯${RST}`
  ];
}
