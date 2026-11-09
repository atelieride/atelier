import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { compileWorld } from '../compile/index';
import { DEMO_HOME, accountDir, claudeAccountsAt } from '../world/accounts';
import { claudeScreen } from '../engine/claude-screen';
import { createDemo } from './index';

// The bridge's startup answers and the first live behaviours: the app renders the overview scene
// from them, and the events come in the order main sends them.

const compiled = compileWorld();
const NOW = compiled.t0 + 5 * 86_400_000; // opened five days after the build
const make = () => createDemo(compiled, { version: '9.9.9', now: () => NOW });
const auth = compiled.sessions.find((s) => s.scenario === 'auth-refactor')!;

describe('startup', () => {
  test("the platform: darwin unless the shell says the visitor isn't on a Mac (then linux: Ctrl keys, POSIX paths)", () => {
    expect(make().api.platform).toBe('darwin');
    expect(createDemo(compiled, { version: '9.9.9', now: () => NOW, platform: 'linux' }).api.platform).toBe('linux');
  });

  test("installed fonts: common monospaced families, never the browser's own font list", async () => {
    const fonts = await make().api.localFonts();
    expect(fonts).toEqual(['Menlo', 'Monaco', 'SF Mono', 'Courier New', 'Consolas', 'Cascadia Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono']);
  });

  test('no OS version: the demo never plays Windows, so its xterms get no Windows pty', () => {
    expect(make().api.osVersion).toBe('');
  });

  test('the project, a connected atelierd with every capability, the five sessions', async () => {
    const { api } = make();
    expect(await api.project()).toEqual({ root: compiled.project.root, name: 'acme-store', realRoot: compiled.project.root });
    expect(await api.daemonState()).toMatchObject({ connected: true, listed: true, mismatch: false, incompatible: false, profilesAvailable: true, states2Available: true, backgroundAvailable: true, aliasesAvailable: true, namesAvailable: true });
    expect((await api.terminals.list()).map((t) => t.name)).toEqual(['auth-refactor', 'billing-tests', 'onboarding-copy', 'db-migration', 'docs']);
  });

  test("the world is on the visitor's clock (a session updated just before the build is updated just before now)", async () => {
    const { api } = make();
    const t = (await api.terminals.list())[0]!;
    expect(NOW - t.session!.updatedAt).toBe(compiled.t0 - auth.terminal.session!.updatedAt);
    const [u] = await api.usage();
    expect(u!.usage.fiveHour!.resetsAt - Math.floor(NOW / 1000)).toBe(7230);
  });

  test("the overview's tabs, once, auth-refactor in front", async () => {
    const { api } = make();
    expect(await api.tabs.restore()).toEqual({ files: [], order: compiled.tabs.order, active: `t:${auth.terminal.id}` });
    expect(await api.tabs.restore()).toBeNull();
  });

  test('Changes: four modified files, attributed', async () => {
    const { api } = make();
    const [repo] = await api.git.status();
    expect(repo!.changes.map((c) => c.rel)).toEqual(['README.md', 'src/auth/session.ts', 'src/pages/welcome.tsx', 'tests/billing.test.ts']);
    expect((await api.attributions()).length).toBe(4);
    expect(await api.git.head(`${compiled.project.root}/src/auth/session.ts`)).toEqual({ original: compiled.head['src/auth/session.ts'] });
  });

  test('files: the tree, a file, the ⌘K index', async () => {
    const { api } = make();
    const root = compiled.project.root;
    expect((await api.files.list(root, false)).map((e) => [e.name, e.dir])).toEqual([['prisma', true], ['src', true], ['tests', true], ['compose.yml', false], ['package.json', false], ['README.md', false]]);
    expect((await api.files.list(`${root}/src`, false)).map((e) => e.rel)).toEqual(['src/auth', 'src/billing', 'src/pages']);
    expect(await api.files.read(`${root}/README.md`)).toMatchObject({ kind: 'text', rel: 'README.md', text: compiled.files['README.md'] });
    expect(await api.files.read(`${root}/nope.ts`)).toMatchObject({ kind: 'missing' });
    expect(await api.files.read('/etc/hosts')).toMatchObject({ kind: 'outside' });
    expect((await api.files.index()).map((f) => f.rel)).toContain('src/auth/session.ts');
    expect(await api.files.resolve('src/auth/session.ts', root)).toEqual({ path: `${root}/src/auth/session.ts`, rel: 'src/auth/session.ts' });
  });

  test('Docker and Redis: the compiled snapshot, inspect by id', async () => {
    const { api } = make();
    const snap = await api.docker.snapshot();
    expect(snap.engine.state).toBe('running');
    const api1 = snap.containers.find((c) => c.name === 'api')!;
    expect(await api.docker.inspect(api1.id)).toMatchObject({ container: { id: api1.id }, detail: { command: expect.any(String) } });
    expect((await api.redis.status()).info?.ops).toBe(41);
  });

  test('Databases: the acme-store Postgres, selected, connected once the view shows (bridge/databases.test.ts)', async () => {
    const { api } = make();
    const snap = await api.databases.snapshot();
    expect(snap.connections.map((v) => [v.conn.name, v.conn.database, v.state])).toEqual([['acme', 'acme', 'idle']]);
    expect(snap).toMatchObject({ selected: snap.connections[0]!.conn.id, catalog: null });
  });
});

describe('settings', () => {
  test('set applies the patch and echoes it on on.settings, as main does', async () => {
    const { api } = make();
    const seen: unknown[] = [];
    api.on.settings((s) => seen.push(s));
    const next = await api.settings.set({ terminalFontSize: 15 });
    expect(next).toMatchObject({ terminalFontSize: 15 });
    expect(seen).toEqual([next]);
    expect(await api.settings.get()).toEqual(next);
  });

  test("starts from the defaults with dictation, Services and Automations on and the world's two Claude accounts (the screenshots' setup)", async () => {
    expect(await make().api.settings.get()).toEqual({ ...DEFAULT_SETTINGS, dictationEnabled: true, showServices: true, automationsEnabled: true, claudeAccounts: claudeAccountsAt(DEMO_HOME) });
  });

  test("Claude's dirs: the default account's under the fictional home", async () => {
    expect(await make().api.claude.dirs()).toEqual({ defaultDir: accountDir(DEMO_HOME, 'default'), home: DEMO_HOME });
  });

  test('Claude Code compatibility: an empty notebook from 2.1.316, Clear resolves, nothing is ever pushed', async () => {
    const { api, events } = make();
    expect((await api.daemonState()).signalsAvailable).toBe(true);
    const pushed: unknown[] = [];
    api.on.claudeSignals((b) => pushed.push(b));
    expect(await api.claudeSignals.get()).toEqual({ lastVersion: '2.1.316', since: 0, entries: [] });
    await expect(api.claudeSignals.clear()).resolves.toBeUndefined();
    expect(await api.claudeSignals.get()).toEqual({ lastVersion: '2.1.316', since: 0, entries: [] });
    expect(pushed).toEqual([]);
    expect(events.count('claudeSignals')).toBe(1);
  });
});

describe('terminals', () => {
  test('attach sends the snapshot before it resolves, then a resize redraws as data', async () => {
    const { api } = make();
    const log: string[] = [];
    // Claude Code's bracketed paste mode first (the snapshot resets the terminal's modes).
    api.on.snapshot((id, data) => log.push(`snapshot ${id} ${data === `\u001b[?2004h${claudeScreen(auth.screen, 31, 79)}` ? 'at 79x31' : 'other'}`));
    api.on.data((id, data) => log.push(`data ${id} ${data === claudeScreen(auth.screen, 40, 120) ? 'at 120x40' : 'other'}`));
    api.terminals.resize(auth.terminal.id, 79, 31);
    const attached = api.terminals.attach(auth.terminal.id).then(() => log.push('resolved'));
    expect(log).toEqual([]); // nothing synchronously: events come after the caller's await, like IPC
    await attached;
    api.terminals.resize(auth.terminal.id, 120, 40);
    api.terminals.resize(auth.terminal.id, 120, 40); // the same size again: no redraw
    expect(log).toEqual([`snapshot ${auth.terminal.id} at 79x31`, 'resolved', `data ${auth.terminal.id} at 120x40`]);
  });

  test('no redraw for a terminal nobody attached', () => {
    const { api } = make();
    const data: string[] = [];
    api.on.data((id) => data.push(id));
    api.terminals.resize(auth.terminal.id, 100, 30);
    expect(data).toEqual([]);
  });

  test('markSeen clears unread and sends the list', async () => {
    const { api, context } = make();
    const docs = compiled.sessions.find((s) => s.scenario === 'docs')!.terminal.id;
    context.state.terminals = context.state.terminals.map((t) => (t.id === docs ? { ...t, session: { ...t.session!, unread: true } } : t));
    const lists: number[] = [];
    api.on.terminals((l) => lists.push(l.length));
    await api.terminals.markSeen(docs);
    expect((await api.terminals.list()).find((t) => t.id === docs)?.session?.unread).toBe(false);
    expect(lists).toEqual([5]);
    await api.terminals.markSeen(docs); // already seen: nothing sent
    expect(lists).toEqual([5]);
  });

  test('rename names the terminal and sends the list', async () => {
    const { api } = make();
    await api.terminals.rename(auth.terminal.id, 'tokens');
    expect((await api.terminals.list())[0]).toMatchObject({ name: 'tokens', title: 'tokens' });
  });
});

describe('events', () => {
  test('a listener can unsubscribe; one that throws does not stop the others', () => {
    const { events, api } = make();
    const got: string[] = [];
    const off = api.on.select((id) => got.push(`a ${id}`));
    api.on.select(() => { throw new Error('boom'); });
    api.on.select((id) => got.push(`c ${id}`));
    const err = console.error;
    console.error = () => {};
    try {
      events.emit('select', 'x');
      off();
      events.emit('select', 'y');
    } finally { console.error = err; }
    expect(got).toEqual(['a x', 'c x', 'c y']);
    expect(events.count('select')).toBe(2);
  });
});
