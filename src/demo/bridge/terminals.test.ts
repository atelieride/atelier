import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { feedKey, type BackgroundFeed } from '../../shared/background-feed';
import type { TerminalInfo } from '../../shared/protocol';
import { jobPrompt, type JobInfo } from '../../shared/redis-queues';
import { compileWorld } from '../compile/index';
import { DEMO_HOME, accountDir } from '../world/accounts';
import { CLAUDE_START_MS } from './terminals';
import { createDemo } from './index';

// The terminals and the Claude beats, live: what the visitor's keys do to
// the scripted sessions, the states the sidebar and ⌘J follow, the edits Changes lists, new sessions and terminals.

const compiled = compileWorld();
const id = (name: string) => compiled.sessions.find((s) => s.scenario === name)!.terminal.id;
const ESC = '\u001b';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(compiled.t0 + 86_400_000); });
afterEach(() => { vi.useRealTimers(); });

function demo() {
  const d = createDemo(compiled, { version: '9.9.9', now: () => Date.now() });
  const lists: TerminalInfo[][] = [];
  const data = new Map<string, string>();
  const events: string[] = [];
  d.api.on.terminals((l) => lists.push(l));
  d.api.on.data((tid, s) => data.set(tid, (data.get(tid) ?? '') + s));
  d.api.on.snapshot((tid, s) => data.set(tid, s));
  d.api.on.exit((tid) => events.push(`exit ${tid}`));
  d.api.on.select((tid) => events.push(`select ${tid}`));
  const term = (tid: string) => d.context.state.terminals.find((t) => t.id === tid);
  const session = (tid: string) => term(tid)?.session;
  const open = async (tid: string) => { d.api.terminals.resize(tid, 80, 30); await d.api.terminals.attach(tid); };
  const type = (tid: string, s: string) => d.api.terminals.input(tid, s);
  /** The screen's text so far, styles dropped. */
  const screen = (tid: string) => (data.get(tid) ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  return { ...d, lists, data, events, term, session, open, type, screen };
}

describe('auth-refactor', () => {
  test('1: the tests run, Claude fixes session.ts (attributed), done about 15 s later', async () => {
    const d = demo();
    const auth = id('auth-refactor');
    await d.open(auth);
    expect(d.session(auth)).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    const changed: string[][] = [];
    d.api.on.fsChanged((p) => changed.push(p));
    d.type(auth, '1');
    expect(d.screen(auth)).toContain('Running…');
    vi.advanceTimersByTime(3000);
    expect(d.session(auth)).toMatchObject({ state: 'running', waitingFor: null });
    expect(d.screen(auth)).toContain('accepts a token inside the clock skew');
    vi.advanceTimersByTime(20_000);
    expect(d.session(auth)).toMatchObject({ state: 'done', unread: true, activity: null });
    expect(d.session(auth)!.updatedAt).toBeGreaterThan(Date.now() - 20_000);
    expect(d.context.state.files['src/auth/session.ts']).toContain('entry.expiresAt + SKEW_MS < now');
    expect(changed).toContainEqual([`${compiled.project.root}/src/auth/session.ts`]);
    expect(d.context.state.attributions.find((a) => a.path.endsWith('/src/auth/session.ts'))).toMatchObject({ terminalId: auth, title: 'auth-refactor', color: d.term(auth)!.color, sessionId: d.session(auth)!.sessionId });
    expect(d.screen(auth)).toContain('all 7 auth tests pass');
    expect(d.session(auth)!.cost!.usd).toBeGreaterThan(1.84);
  });

  test('Enter takes the picked option; ↓↓ Enter is No: "OK, I won\'t run it", done, nothing edited', async () => {
    const d = demo();
    const auth = id('auth-refactor');
    await d.open(auth);
    d.type(auth, `${ESC}[B`);
    expect(d.data.get(auth)).toContain(`${ESC}[36m❯ 2. Yes, and don't ask again`);
    d.type(auth, `${ESC}[B\r`);
    vi.advanceTimersByTime(5000);
    expect(d.session(auth)).toMatchObject({ state: 'done', waitingFor: null });
    expect(d.screen(auth)).toContain("OK, I won't run it.");
    expect(d.context.state.files['src/auth/session.ts']).toBe(compiled.files['src/auth/session.ts']);
  });

  test('Esc says no too; option 2 runs like 1', async () => {
    const d = demo();
    d.type(id('auth-refactor'), ESC);
    vi.advanceTimersByTime(5000);
    expect(d.session(id('auth-refactor'))?.state).toBe('done');
    const e = demo();
    e.type(id('auth-refactor'), '2');
    vi.advanceTimersByTime(25_000);
    expect(e.context.state.files['src/auth/session.ts']).toContain('+ SKEW_MS');
  });
});

describe('db-migration', () => {
  const sql = (d: ReturnType<typeof demo>) => Object.entries(d.context.state.files).find(([k]) => k.endsWith('/migration.sql'))?.[1];

  test('↓ Enter: pending — the schema and a migration without an update, done', async () => {
    const d = demo();
    const db = id('db-migration');
    await d.open(db);
    d.type(db, `${ESC}[B\r`);
    expect(d.screen(db)).toContain('> pending');
    vi.advanceTimersByTime(20_000);
    expect(d.session(db)).toMatchObject({ state: 'done' });
    expect(d.context.state.files['prisma/schema.prisma']).toContain('status    OrderStatus @default(pending)');
    expect(sql(d)).toBeDefined();
    expect(sql(d)).not.toContain('UPDATE');
  });

  test('1: paid — existing orders updated', () => {
    const d = demo();
    d.type(id('db-migration'), '1');
    vi.advanceTimersByTime(20_000);
    expect(sql(d)).toContain(`UPDATE "Order" SET "status" = 'paid';`);
  });

  test('3: type the answer, Enter: it lands in the transcript and the migration', async () => {
    const d = demo();
    const db = id('db-migration');
    await d.open(db);
    d.type(db, '3');
    d.type(db, 'archived if older than 2025');
    expect(d.screen(db)).toContain('> archived if older than 2025');
    d.type(db, '\r');
    vi.advanceTimersByTime(20_000);
    expect(sql(d)).toContain('-- TODO for existing orders: archived if older than 2025');
    expect(d.screen(db)).toContain('Noted: “archived if older than 2025”');
  });
});

describe('billing-tests and docs (auto)', () => {
  test('billing works on its own and is done about 90 s in (⌘J then has something new)', () => {
    const d = demo();
    const b = id('billing-tests');
    vi.advanceTimersByTime(45_000);
    expect(d.session(b)).toMatchObject({ state: 'running', subagents: 1 });
    expect(d.term(b)!.work).toMatchObject({ agents: 1 });
    vi.advanceTimersByTime(40_000);
    expect(d.session(b)!.state).toBe('running');
    expect(d.term(b)!.recent?.find((r) => r.id === 'b7k2m9q4x')).toMatchObject({ exit: 1 });
    vi.advanceTimersByTime(10_000);
    expect(d.session(b)).toMatchObject({ state: 'done', unread: true });
    expect(d.context.state.files['src/billing/invoice.ts']).toContain('Number.EPSILON');
  });

  test('docs keeps working; its cron moves on when it fires', () => {
    const d = demo();
    const docs = id('docs');
    const next = d.term(docs)!.work!.crons[0]!.next!;
    vi.advanceTimersByTime(next - Date.now() + 10);
    expect(d.term(docs)!.work!.crons[0]!.next).toBe(next + 30 * 60_000);
    expect(d.session(docs)!.state).toBe('running');
  });

  test("the spinner turns (only its line is redrawn) and counts seconds", async () => {
    const d = demo();
    const b = id('billing-tests');
    await d.open(b);
    const before = d.data.get(b)!;
    vi.advanceTimersByTime(1200);
    const frames = d.data.get(b)!.slice(before.length);
    expect(frames).toContain(`${ESC}[2K`);
    expect(frames).not.toContain(`${ESC}[2J`);
    expect(frames).toMatch(/[·✢✳✶✻✽] Writing tests…/);
  });
});

describe('Esc while Claude works', () => {
  test('interrupts it, as Claude Code does: "Interrupted by user", the prompt back, the session ready; the beat stops', async () => {
    const d = demo();
    const auth = id('auth-refactor');
    await d.open(auth);
    d.type(auth, '1');
    vi.advanceTimersByTime(3000);
    expect(d.session(auth)!.state).toBe('running');
    const lists = d.lists.length;
    d.type(auth, ESC);
    expect(d.screen(auth)).toContain('⎿  Interrupted by user');
    expect(d.session(auth)).toMatchObject({ state: 'idle', activity: null, waitingFor: 'input' });
    expect(d.lists.length).toBeGreaterThan(lists);
    // Nothing more happens: no edit, no answer, the spinner stopped.
    const shown = d.data.get(auth)!.length;
    vi.advanceTimersByTime(30_000);
    expect(d.data.get(auth)!.length).toBe(shown);
    expect(d.session(auth)!.state).toBe('idle');
    expect(d.context.state.files['src/auth/session.ts']).toBe(compiled.files['src/auth/session.ts']);
    // The prompt is free: a new prompt plays a free-prompt beat.
    d.type(auth, 'go on\r');
    expect(d.session(auth)!.state).toBe('running');
  });

  test('a free-prompt beat is interrupted too; Esc at rest or on a menu keeps its own meaning', async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    await d.open(ob);
    d.type(ob, ESC);
    expect(d.session(ob)!.state).toBe('done');
    expect(d.screen(ob)).not.toContain('Interrupted');
    d.type(ob, 'tidy up\r');
    vi.advanceTimersByTime(800);
    d.type(ob, ESC);
    expect(d.session(ob)!.state).toBe('idle');
    expect(d.screen(ob)).toContain('Interrupted by user');
  });

  test('billing-tests (background agents at work) goes on: the app would not see it stop', async () => {
    const d = demo();
    const b = id('billing-tests');
    await d.open(b);
    d.type(b, ESC);
    expect(d.session(b)!.state).toBe('running');
    expect(d.screen(b)).not.toContain('Interrupted');
    vi.advanceTimersByTime(95_000);
    expect(d.session(b)!.state).toBe('done');
  });
});

describe('a free prompt', () => {
  test('typed in a done session: echo, Backspace, Enter → reads, asks to edit (waiting), 1 → edits, done', async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    await d.open(ob);
    d.type(ob, 'add dark modx');
    d.type(ob, '\x7fe');
    expect(d.screen(ob)).toContain('> add dark mode');
    d.type(ob, '\r');
    expect(d.session(ob)).toMatchObject({ state: 'running', unread: false });
    vi.advanceTimersByTime(8000);
    expect(d.session(ob)).toMatchObject({ state: 'waiting', waitingFor: 'permission' });
    expect(d.screen(ob)).toContain('Do you want to make this edit to src/auth/tokens.ts?');
    expect(d.screen(ob)).not.toMatch(/demo|script/i);
    d.type(ob, '1');
    vi.advanceTimersByTime(8000);
    expect(d.session(ob)!.state).toBe('done');
    expect(d.context.state.files['src/auth/tokens.ts']).toContain('delete(token: string)');
    expect(d.context.state.attributions.find((a) => a.path.endsWith('/src/auth/tokens.ts'))).toMatchObject({ terminalId: ob });
  });

  test('the next prompt, in any session, plays the next free-prompt beat', async () => {
    const d = demo();
    await d.open(id('onboarding-copy'));
    d.type(id('onboarding-copy'), 'one\r');
    vi.advanceTimersByTime(8000);
    d.type(id('onboarding-copy'), '3');
    vi.advanceTimersByTime(5000);
    d.type(id('onboarding-copy'), 'two\r');
    vi.advanceTimersByTime(8000);
    expect(d.screen(id('onboarding-copy'))).toContain('src/billing/invoice.ts');
  });

  test('Enter does nothing while Claude works or asks', () => {
    const d = demo();
    d.type(id('billing-tests'), 'later\r');
    expect(d.session(id('billing-tests'))!.state).toBe('running');
    expect(d.context.state.prompts.get(id('billing-tests'))).toBeUndefined();
  });

  // Ask reads "your requests": each prompt the visitor sends, as its title would read it.
  test('every prompt sent is recorded for its terminal, with its time; /clear and an empty line are not prompts', () => {
    const d = demo();
    const ob = id('onboarding-copy');
    d.type(ob, '/clear\r');
    d.type(ob, '\r');
    expect(d.context.state.prompts.get(ob)).toBeUndefined();
    d.type(ob, `add   dark mode${' to every page of the store and its emails'.repeat(2)}\r`);
    expect(d.context.state.prompts.get(ob)).toEqual([{ text: expect.stringMatching(/^add dark mode to every page.*…$/), at: Date.now() }]);
    expect(d.context.state.prompts.get(ob)![0]!.text.length).toBeLessThanOrEqual(60);
  });

  // Context usage's Compact and Run /context type Claude Code's own commands: the
  // demo doesn't play them, so it says so in one line — never a scripted turn that edits the project.
  test('a slash command other than /clear says it runs on the Mac: no turn, no edit, not a prompt', async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    await d.open(ob);
    const files = { ...d.context.state.files };
    const before = d.session(ob);
    for (const cmd of ['/compact', '/context', '/review the auth module']) {
      d.type(ob, `${cmd}\r`);
      vi.advanceTimersByTime(15_000);
      expect(d.screen(ob)).toContain(`${cmd.split(' ')[0]} runs in Claude Code on your Mac`);
    }
    expect(d.context.state.files).toEqual(files);
    expect(d.context.state.prompts.get(ob)).toBeUndefined();
    expect(d.session(ob)?.state).toBe(before?.state);
    // A path with a folder in it is a prompt; a lone `/word` is a command, as Claude Code reads it.
    d.type(ob, '/src/auth explain it\r');
    expect(d.context.state.prompts.get(ob)?.map((p) => p.text)).toEqual(['/src/auth explain it']);
  });

  // /clear empties the context, so the status line's context starts over, and the Context
  // sheet's live count falls below its last analysis ("compacted since · Refresh").
  test('/clear empties the session\'s context', async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    await d.open(ob);
    expect(d.session(ob)?.contextPct).toBe(18);
    d.type(ob, '/clear\r');
    expect(d.context.state.cleared.has(ob)).toBe(true);
    expect(d.session(ob)?.contextPct).toBe(0);
  });

  // /clear starts the conversation over (Claude Code), and a closed terminal keeps nothing.
  test('/clear forgets the prompts sent before it; closing the terminal forgets them too', async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    d.type(ob, 'add dark mode\r');
    vi.advanceTimersByTime(8000);
    d.type(ob, '3');
    vi.advanceTimersByTime(5000);
    expect(d.context.state.prompts.get(ob)).toHaveLength(1);
    d.type(ob, '/clear\r');
    expect(d.context.state.prompts.has(ob)).toBe(false);
    d.type(ob, 'and a footer\r');
    expect(d.context.state.prompts.get(ob)?.map((p) => p.text)).toEqual(['and a footer']);
    await d.api.terminals.close(ob);
    expect(d.context.state.prompts.has(ob)).toBe(false);
  });
});

describe('"send to session" diagnoses', () => {
  test("Docker's crash text, pasted then Enter: Claude explains and fixes REDIS_URL in compose.yml", async () => {
    const d = demo();
    const ob = id('onboarding-copy');
    await d.open(ob);
    const text = 'Lines from the logs of the Docker container `worker`:\n\n```\nError: connect ECONNREFUSED 127.0.0.1:6379\n```';
    d.type(ob, '\x1b[200~');
    d.type(ob, text.replace(/\n/g, '\r'));
    d.type(ob, '\x1b[201~');
    expect(d.screen(ob)).toContain('[Pasted text #1 +5 lines]');
    d.type(ob, '\r');
    vi.advanceTimersByTime(10_000);
    expect(d.screen(ob)).toContain('REDIS_URL should name the service');
    d.type(ob, '\r');
    vi.advanceTimersByTime(8000);
    expect(d.context.state.files['compose.yml']).toContain('REDIS_URL: redis://redis:6379');
  });

  test("Redis's failed job: Claude adds SMTP_URL for the worker", () => {
    const d = demo();
    const ob = id('onboarding-copy');
    const job = { id: '8812', name: 'send-receipt', reason: 'connect ECONNREFUSED 127.0.0.1:1025', attempts: 3, maxAttempts: 3, at: 1, queuedAt: 1, processedOn: 1, finishedOn: 1, stacks: [] } as unknown as JobInfo;
    d.type(ob, `\x1b[200~${jobPrompt({ lib: 'bullmq', queue: 'email-queue', instance: 'Docker · redis' }, job).replace(/\n/g, '\r')}\x1b[201~\r`);
    vi.advanceTimersByTime(12_000);
    d.type(ob, '1');
    vi.advanceTimersByTime(8000);
    expect(d.context.state.files['compose.yml']).toContain('SMTP_URL: smtp://mailpit:1025');
  });
});

describe('new terminals and sessions', () => {
  test('create: the demo shell, "Terminal 1", then 2; the list goes out each time', async () => {
    const d = demo();
    const t1 = await d.api.terminals.create({ cols: 80, rows: 24 });
    const t2 = await d.api.terminals.create({ cols: 80, rows: 24 });
    expect(t1).toMatchObject({ title: 'Terminal 1', name: null, foreground: 'zsh', session: null, projectRoot: compiled.project.root, profile: 'atelier' });
    expect(t2.title).toBe('Terminal 2');
    expect(t1.color).not.toBe(t2.color);
    expect(d.lists.at(-1)!.map((t) => t.id)).toEqual([...compiled.sessions.map((s) => s.terminal.id), t1.id, t2.id]);
    await d.open(t1.id);
    expect(d.data.get(t1.id)).toContain('~/code/acme-store');
  });

  test('createSession: starting (no session), then Claude idle a moment later, with its welcome screen', async () => {
    const d = demo();
    const t = await d.api.terminals.createSession({ cols: 80, rows: 24 });
    expect(t).toMatchObject({ title: 'Claude · acme-store', foreground: 'claude', session: null });
    await d.open(t.id);
    expect(d.screen(t.id)).toContain('Welcome to Claude Code');
    vi.advanceTimersByTime(CLAUDE_START_MS);
    expect(d.session(t.id)).toMatchObject({ state: 'idle', model: 'Opus 5.5', cwd: compiled.project.root });
    expect(d.session(t.id)!.sessionId).not.toBe(compiled.beats.fresh.session.sessionId);
    d.type(t.id, 'write a changelog\r');
    expect(d.term(t.id)).toMatchObject({ title: 'write a changelog', session: { autoTitle: 'write a changelog', state: 'running' } });
  });

  test('Claude accounts: a new session runs as the account picked (Work), else the default; its dir known once Claude starts', async () => {
    const d = demo();
    const work = await d.api.terminals.createSession({ cols: 80, rows: 24, account: 'work' });
    const plain = await d.api.terminals.createSession({ cols: 80, rows: 24 });
    expect(d.term(work.id)!.configDir).toBeUndefined();
    vi.advanceTimersByTime(CLAUDE_START_MS);
    expect(d.term(work.id)!.configDir).toBe(accountDir(DEMO_HOME, 'work'));
    expect(d.term(plain.id)!.configDir).toBe(accountDir(DEMO_HOME, 'default'));
  });

  test('Claude accounts: an account the settings don\'t have is refused, as main refuses it', async () => {
    const d = demo();
    await expect(d.api.terminals.createSession({ cols: 80, rows: 24, account: 'nobody' })).rejects.toThrow('unknown Claude account');
    expect(d.context.state.terminals).toHaveLength(compiled.sessions.length);
  });

  test('a named session keeps its name', async () => {
    const d = demo();
    const t = await d.api.terminals.createSession({ cols: 80, rows: 24, name: 'spike' });
    vi.advanceTimersByTime(CLAUDE_START_MS);
    d.type(t.id, 'go\r');
    expect(d.term(t.id)!.title).toBe('spike');
  });

  test('close: the exit, then the list without it; the beat stops', async () => {
    const d = demo();
    const t = await d.api.terminals.create({ cols: 80, rows: 24 });
    await d.api.terminals.close(t.id);
    expect(d.events).toEqual([`exit ${t.id}`]);
    expect(d.lists.at(-1)!.some((x) => x.id === t.id)).toBe(false);
    await d.api.terminals.close(id('billing-tests'));
    vi.advanceTimersByTime(120_000);
    expect(d.term(id('billing-tests'))).toBeUndefined();
  });

  test('rename sets the title, clearing it falls back to the default', async () => {
    const d = demo();
    const t = await d.api.terminals.create({ cols: 80, rows: 24 });
    await d.api.terminals.rename(t.id, 'logs');
    expect(d.term(t.id)!.title).toBe('logs');
    await d.api.terminals.rename(t.id, null);
    expect(d.term(t.id)).toMatchObject({ title: 'Terminal 1', name: null });
  });

  test("the shell's `claude`: a new session, selected like a notification click", async () => {
    const d = demo();
    const t = await d.api.terminals.create({ cols: 80, rows: 24 });
    d.type(t.id, 'claude\r');
    const s = d.context.state.terminals.at(-1)!;
    expect(s).toMatchObject({ foreground: 'claude', title: 'Claude · acme-store' });
    expect(d.events).toEqual([`select ${s.id}`]);
  });

  test('a snapshot turns bracketed paste on (send-to-session checks it), attach of an unknown id fails', async () => {
    const d = demo();
    await d.open(id('docs'));
    expect(d.data.get(id('docs'))!.startsWith(`${ESC}[?2004h`)).toBe(true);
    await expect(d.api.terminals.attach('nope')).rejects.toThrow();
  });
});

describe('background feeds', () => {
  const feeds = (d: ReturnType<typeof demo>) => { const got: BackgroundFeed[] = []; d.api.on.backgroundFeed((f) => got.push(f)); return got; };

  test("an agent's timeline: whole on watch, a step more as it works, nothing after unwatch", async () => {
    const d = demo();
    const got = feeds(d);
    const b = id('billing-tests');
    expect(await d.api.background.watch(b, 'a1')).toEqual({ ok: true });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ key: feedKey(b, 'a1'), kind: 'timeline' });
    expect(got[0]!.kind === 'timeline' && got[0]!.entries.length).toBe(3);
    vi.advanceTimersByTime(8000);
    const last = got.at(-1)!;
    expect(last.kind === 'timeline' && last.entries.length).toBe(4);
    d.api.background.unwatch(b, 'a1');
    vi.advanceTimersByTime(60_000);
    expect(got).toHaveLength(2);
  });

  test('the vitest shell: its lines so far, then each new one, the exit code at the end', async () => {
    const d = demo();
    const got = feeds(d);
    const b = id('billing-tests');
    await d.api.background.watch(b, 'b7k2m9q4x');
    expect(got[0]).toMatchObject({ kind: 'output', reset: true, seq: 12, exit: null });
    vi.advanceTimersByTime(2000);
    expect(got[1]).toMatchObject({ kind: 'output', reset: false, seq: 13, lines: [expect.any(String)] });
    vi.advanceTimersByTime(50_000);
    expect(got.at(-1)).toMatchObject({ exit: 1, lines: [expect.stringContaining('Duration')] });
  });

  test('an item with no feed: missing', async () => {
    expect(await demo().api.background.watch(id('docs'), 'c1')).toEqual({ ok: false, reason: 'missing' });
  });
});
