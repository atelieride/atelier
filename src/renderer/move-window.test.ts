import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import type { AdoptAnswer, MoveRequest, MoveResult } from '@shared/popout';
import { useApp } from './store';
import { single } from './split';
import type { TabKey } from './tabs-model';
import { adoptDecision, applyAdopt, canMoveToWindow, moveToWindow, moveToWindowCommands, moveToWindowItems, windowLabels } from './move-window';
import { EMPTY_DB_SNAPSHOT, type DbConnView, type DbScope } from '@shared/databases';
import { useDb } from './databases/store';

// Moving a file or a plain terminal to another project's window.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
const answers: AdoptAnswer[] = [];
const sent: MoveRequest[] = [];
let reply: MoveResult = { ok: true };
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = {
    addEventListener: () => {},
    atelier: {
      projectWindows: {
        adopted: async (a: AdoptAnswer) => { answers.push(a); },
        moveTab: async (r: MoveRequest) => { sent.push(r); return reply; }
      },
      popout: { focus: async () => {} }
    }
  };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const term = (id: string, session = false): TerminalInfo => ({
  id, projectRoot: '/a', cwd: '/a', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt: 1, session: session ? { sessionId: 's', state: 'idle' } as never : null
});
const st = () => useApp.getState();
const FUTURE = Date.now() + 60_000;
const WINDOWS = [{ root: '/a', name: 'alpha' }, { root: '/b', name: 'beta' }, { root: '/c', name: 'gamma' }];

beforeEach(() => {
  answers.length = 0;
  sent.length = 0;
  reply = { ok: true };
  useApp.setState({
    project: { root: '/a', name: 'alpha', realRoot: '/a' }, popout: null, terminals: [term('t1'), term('s1', true)], starting: {}, selectedId: null, activeTab: 'term',
    tabOrder: ['t:t1', 't:s1', 'f:/a/x.ts'] as TabKey[], hidden: [], openFiles: [{ path: '/a/x.ts', rel: 'x.ts', mode: 'margin', line: null, nonce: 0 } as never], preview: null, split: single(),
    dirty: { '/a/x.ts': true }, poppedOut: [], ws: null, toast: null, projectWindows: WINDOWS
  });
});

describe('what can move, and where', () => {
  test('files on disk and plain terminals; never a session (or one starting), an untitled buffer or a project view', () => {
    expect(canMoveToWindow(st(), 'f:/a/x.ts')).toBe(true);
    expect(canMoveToWindow(st(), 't:t1')).toBe(true);
    expect(canMoveToWindow(st(), 't:s1')).toBe(false);
    expect(canMoveToWindow({ ...st(), starting: { t1: 1 } as never }, 't:t1')).toBe(false);
    expect(canMoveToWindow(st(), 'f:untitled:1' as TabKey)).toBe(false);
    expect(canMoveToWindow(st(), 'review')).toBe(false);
  });
  test('the menu: Move to Window › the other project windows, by name (the parent folder when two names match); none alone', () => {
    const items = moveToWindowItems('f:/a/x.ts');
    expect(items).toHaveLength(1);
    const sub = (items[0] as { submenu: { label: string }[] }).submenu;
    expect(sub.map((i) => i.label)).toEqual(['beta', 'gamma']);
    expect(moveToWindowItems('t:s1')).toEqual([]);
    useApp.setState({ projectWindows: [WINDOWS[0]!] });
    expect(moveToWindowItems('f:/a/x.ts')).toEqual([]);
    expect(windowLabels([{ root: '/x/app', name: 'app' }, { root: '/y/app', name: 'app' }, { root: '/z/web', name: 'web' }])).toEqual(['app — x', 'app — y', 'web']);
  });
});

describe('moving out', () => {
  test('a dirty file: sent with its view, gone from this window (and not unsaved here any more) once the other said yes', async () => {
    await moveToWindow('f:/a/x.ts', '/b');
    expect(sent).toEqual([{ to: '/b', key: 'f:/a/x.ts', payload: { kind: 'file', rel: 'x.ts', mode: 'margin' } }]);
    expect(st().tabOrder).toEqual(['t:t1', 't:s1']);
    expect(st().openFiles).toEqual([]);
    expect(st().dirty).toEqual({});
  });
  test('refused or failed: the tab stays, unsaved as it was, and a toast says why', async () => {
    reply = { ok: false, reason: 'refused' };
    await moveToWindow('f:/a/x.ts', '/b');
    expect(st().tabOrder).toContain('f:/a/x.ts');
    expect(st().dirty).toEqual({ '/a/x.ts': true });
    expect(st().toast?.text).toMatch(/beta/);
    reply = { ok: false, reason: 'failed' };
    await moveToWindow('f:/a/x.ts', '/b');
    expect(st().toast?.text).toBeTruthy();
  });
  test('a terminal leaves with the list main sends (nothing dropped here first)', async () => {
    await moveToWindow('t:t1', '/b');
    expect(sent.at(-1)).toMatchObject({ to: '/b', key: 't:t1' });
    expect(st().tabOrder).toContain('t:t1');
  });
});

describe('moving in', () => {
  const handoff = (doc: string, saved: string | null) => ({ path: '/a/x.ts', state: { doc, selection: null }, saved, stamp: null, eol: 'lf' as const, scrollTop: 0 });
  test('the decision: open it; this window has it — its own comes forward, unless the buffer coming has changes', () => {
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: 'f:/b/y.ts' })).toBe('open');
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: 'f:/a/x.ts', handoff: handoff('a', 'a') })).toBe('own');
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: 'f:/a/x.ts', handoff: handoff('a\nb', 'a\r\nb') })).toBe('own');
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: 'f:/a/x.ts', handoff: handoff('changed', 'a') })).toBe('refuse');
    expect(adoptDecision({ ...st(), openFiles: [], poppedOut: ['f:/a/x.ts'] as TabKey[] }, { id: 1, deadline: FUTURE, key: 'f:/a/x.ts', handoff: handoff('changed', 'a') })).toBe('refuse');
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: 't:t9' })).toBe('open');
    expect(adoptDecision({ ...st(), popout: { key: 't:x' } }, { id: 1, deadline: FUTURE, key: 'f:/b/y.ts' })).toBe('refuse');
  });
  test('a new file opens here with its view and is answered yes; a refusal is answered no with the reason', () => {
    useApp.setState({ project: { root: '/b', name: 'beta', realRoot: '/b' }, tabOrder: [], openFiles: [], dirty: {}, split: single() });
    applyAdopt({ id: 4, deadline: FUTURE, key: 'f:/a/x.ts', payload: { kind: 'file', rel: '/a/x.ts', mode: 'margin' } });
    expect(st().tabOrder).toEqual(['f:/a/x.ts']);
    expect(st().activeKey()).toBe('f:/a/x.ts');
    expect(answers).toEqual([{ id: 4, ok: true }]);
    applyAdopt({ id: 5, deadline: FUTURE, key: 'f:/a/x.ts', handoff: handoff('changed', 'a') });
    expect(answers.at(-1)).toEqual({ id: 5, ok: false, reason: 'open-there' });
  });
  // Never a second buffer of a file the sender kept, never a yes for what didn't land.
  test('past its deadline (the sender gave up and kept it): nothing opens, the answer is no', () => {
    useApp.setState({ project: { root: '/b', name: 'beta', realRoot: '/b' }, tabOrder: [], openFiles: [], dirty: {}, split: single() });
    applyAdopt({ id: 6, deadline: Date.now() - 1, key: 'f:/a/x.ts', payload: { kind: 'file', rel: '/a/x.ts', mode: 'margin' } });
    expect(st().tabOrder).toEqual([]);
    expect(answers.at(-1)).toEqual({ id: 6, ok: false });
  });
  test('a terminal this window doesn\'t list: no; one it lists: selected, yes', () => {
    useApp.setState({ project: { root: '/b', name: 'beta', realRoot: '/b' }, terminals: [term('t1')], tabOrder: ['t:t1'] as TabKey[], openFiles: [], dirty: {}, split: single() });
    applyAdopt({ id: 7, deadline: FUTURE, key: 't:zz' });
    expect(answers.at(-1)).toEqual({ id: 7, ok: false });
    applyAdopt({ id: 8, deadline: FUTURE, key: 't:t1' });
    expect(answers.at(-1)).toEqual({ id: 8, ok: true });
    expect(st().selectedId).toBe('t1');
  });
});

describe('table tabs', () => {
  const C = 'c0123456789ab';
  const ORDERS = `db:${C}/public/orders` as TabKey;
  const REF = { key: ORDERS, connId: C, schema: 'public', name: 'orders', kind: 'table' as const, view: 'structure' as const };
  const PAYLOAD = { kind: 'db' as const, connId: C, schema: 'public', name: 'orders', view: 'structure' as const, rel: 'table' as const };
  const showIn = (scope: DbScope) => useDb.setState({ loaded: true, snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: { id: C, name: 'acme', env: 'local', scope }, state: 'idle', problem: null, server: null, hasPassword: false, provider: null } as unknown as DbConnView] } });
  const sub = () => (moveToWindowItems(ORDERS)[0] as { submenu: { label: string; disabled?: boolean; tip?: string }[] }).submenu;
  beforeEach(() => {
    useApp.setState({ tabOrder: ['t:t1', ORDERS], dbTabs: [REF], dbPreview: null, activeTab: ORDERS });
    useDb.setState({ tabs: {} });
  });
  afterAll(() => useDb.setState({ snap: EMPTY_DB_SNAPSHOT, loaded: false }));

  test('a connection shown in every project: Move to Window › every other window', () => {
    showIn({ kind: 'all' });
    expect(canMoveToWindow(st(), ORDERS)).toBe(true);
    expect(sub().map((i) => [i.label, !!i.disabled])).toEqual([['beta', false], ['gamma', false]]);
    expect(moveToWindowCommands(ORDERS).map((c) => c.root)).toEqual(['/b', '/c']);
  });
  test('this project\'s connection: the other projects\' windows are disabled, saying whose it is; no palette command', () => {
    showIn({ kind: 'project', root: '/a' });
    expect(sub().map((i) => [i.label, !!i.disabled, i.tip])).toEqual([['beta', true, 'This connection belongs to alpha'], ['gamma', true, 'This connection belongs to alpha']]);
    expect(moveToWindowCommands(ORDERS)).toEqual([]);
  });
  test('a connection this window doesn\'t show (another project\'s, removed), or a malformed key: no Move to Window', () => {
    useDb.setState({ loaded: true, snap: EMPTY_DB_SNAPSHOT });
    expect(canMoveToWindow(st(), ORDERS)).toBe(false);
    expect(moveToWindowItems(ORDERS)).toEqual([]);
    showIn({ kind: 'all' });
    expect(canMoveToWindow(st(), 'db:nope')).toBe(false);
  });
  test('moved: sent with its payload, gone from here (with its state) once the other window took it; refused: it stays', async () => {
    showIn({ kind: 'all' });
    useDb.getState().patchTab(ORDERS, { wrap: true });
    reply = { ok: false, reason: 'failed' };
    await moveToWindow(ORDERS, '/b');
    expect(st().tabOrder).toContain(ORDERS);
    reply = { ok: true };
    await moveToWindow(ORDERS, '/b');
    expect(sent.at(-1)).toEqual({ to: '/b', key: ORDERS, payload: PAYLOAD });
    expect(st().tabOrder).toEqual(['t:t1']);
    expect(st().dbTabs).toEqual([]);
    expect(useDb.getState().tabs).toEqual({});
  });
  test('arriving while this window has it in a pop-out: that window comes forward, no second tab here', () => {
    useApp.setState({ project: { root: '/b', name: 'beta', realRoot: '/b' }, tabOrder: [], dbTabs: [], openFiles: [], dirty: {}, split: single(), activeTab: 'term', poppedOut: [ORDERS] });
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: ORDERS, payload: PAYLOAD })).toBe('own');
    applyAdopt({ id: 11, deadline: FUTURE, key: ORDERS, payload: PAYLOAD });
    expect(answers.at(-1)).toEqual({ id: 11, ok: true });
    expect(st().tabOrder).toEqual([]);
    expect(st().dbTabs).toEqual([]);
    expect(st().poppedOut).toEqual([ORDERS]);
    // Not popped out (open in the strip already, or not at all): opened here.
    useApp.setState({ poppedOut: [] });
    expect(adoptDecision(st(), { id: 1, deadline: FUTURE, key: ORDERS, payload: PAYLOAD })).toBe('open');
  });
  test('arriving from another window: opened here in front with its view, answered yes', () => {
    useApp.setState({ project: { root: '/b', name: 'beta', realRoot: '/b' }, tabOrder: [], dbTabs: [], openFiles: [], dirty: {}, split: single(), activeTab: 'term' });
    applyAdopt({ id: 9, deadline: FUTURE, key: ORDERS, payload: PAYLOAD });
    expect(answers.at(-1)).toEqual({ id: 9, ok: true });
    expect(st().tabOrder).toEqual([ORDERS]);
    expect(st().dbTabs).toEqual([REF]);
    expect(st().activeKey()).toBe(ORDERS);
  });
});
