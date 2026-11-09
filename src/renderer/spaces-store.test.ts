import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { LAYOUT_SAVE_MS, useApp } from './store';
import { isSplit, savedKeys, single } from './split';
import { loadLayout as loadSplitLayout, saveLayout as saveSplitLayout } from './layout-store';
import type { TabKey } from './tabs-model';
import { emptyViews } from './spaces';
import { openContainer } from './docker/actions';
import type { AutomationView } from '@shared/api';
import { EMPTY_DB_SNAPSHOT } from '@shared/databases';
import { useDb } from './databases/store';
import { newTerminalIn } from './launch';
import type { WorkspacesState } from './workspaces';

// Spaces in the store: the strip is the active space's; the activity bar
// switches; every opener goes to its key's space; what arrives by itself never switches nor shows in another space.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { addEventListener: () => {}, atelier: {} };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const term = (id: string, createdAt: number): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null
});
const st = () => useApp.getState();
const k = (...keys: string[]) => keys as TabKey[];
const T = { a: term('a', 1), b: term('b', 2), c: term('c', 3) };
const table = (name: string) => ({ connId: 'c0123456789ab', schema: 'public', name, kind: 'table' as const, view: 'data' as const });
const ORDERS = 'db:c0123456789ab/public/orders' as TabKey;
const USERS = 'db:c0123456789ab/public/users' as TabKey;
const API = { kind: 'container', id: 'aaaaaaaaaaaa' } as const;

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, poppedOut: [], terminals: [], selectedId: null, activeTab: 'term', tabOrder: [],
    hidden: [], pins: [], openFiles: [], preview: null, pendingAnchor: null, split: single(), ws: null, review: null, servicesOpen: false,
    dbTabs: [], dbPreview: null, dockerTabs: [], dockerPreview: null, redisTabs: [], autoTabs: [], autoPreview: null,
    space: 'sessions', spaceViews: emptyViews(), activity: 'sessions', sessionsActivity: 'sessions',
    settings: { ...st().settings, previewTabs: true }
  });
  st().setTerminals([T.a, T.b]);
  st().select('a');
});

describe('switching', () => {
  test('tables live in Databases: Sessions keeps its terminals and its front, Databases its tables and its front', () => {
    st().openDbTab(table('orders'), { preview: false });
    st().openDbTab(table('users'), { preview: false });
    st().activate(ORDERS);
    expect(st().space).toBe('databases');
    expect(st().tabOrder).toEqual(k(ORDERS, USERS));
    st().setActivity('sessions');
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
    expect(st().activeKey()).toBe('t:a');
    st().setActivity('databases');
    expect(st().tabOrder).toEqual(k(ORDERS, USERS));
    expect(st().activeKey()).toBe(ORDERS);
    expect(st().activity).toBe('databases');
  });

  test('Files and Source Control show the Sessions space: the strip stays', () => {
    st().setActivity('files');
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
    st().setActivity('scm');
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
  });

  test('back to Sessions with its icon: the activity last used there', () => {
    st().setActivity('scm');
    st().setActivity('docker');
    st().setActivity('sessions');
    expect(st().activity).toBe('sessions');
    st().setActivity('files');
    st().openDocker(API);
    expect(st().space).toBe('docker');
    st().select('b');
    expect(st().space).toBe('sessions');
    expect(st().activity).toBe('files');
  });

  test('a split in Databases is its own: Sessions stays one pane', () => {
    st().openDbTab(table('orders'), { preview: false });
    st().openDbTab(table('users'), { preview: false });
    st().moveTabToNewPane(USERS, 0, 'right');
    expect(isSplit(st().split)).toBe(true);
    st().setActivity('sessions');
    expect(isSplit(st().split)).toBe(false);
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
    st().setActivity('databases');
    expect(isSplit(st().split)).toBe(true);
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k(ORDERS), k(USERS)]);
  });
});

describe('openers go to their space', () => {
  test('a table from Sessions goes to Databases; a session from Databases back to Sessions', () => {
    st().openDbTab(table('orders'), { preview: false });
    expect(st().space).toBe('databases');
    expect(st().activity).toBe('databases');
    st().select('b');
    expect(st().space).toBe('sessions');
    expect(st().activeKey()).toBe('t:b');
  });

  test('a Docker target, a Redis view, an automation: each to its space', () => {
    st().openDocker(API);
    expect([st().space, st().activeKey()]).toEqual(['docker', 'dk:c:aaaaaaaaaaaa']);
    st().openRedis('keys');
    expect([st().space, st().activeKey()]).toEqual(['redis', 'rd:keys']);
    st().openAutomations(null);
    expect([st().space, st().activeKey()]).toEqual(['automations', 'au:all']);
    expect(st().tabOrder).toEqual(k('au:all'));
  });

  test('a key living in a pop-out only brings its window forward: nothing switches here', () => {
    const focus = vi.fn(async () => {});
    (globalThis as { window: { atelier: unknown } }).window.atelier = { popout: { focus } };
    useApp.setState({ poppedOut: ['dk:c:aaaaaaaaaaaa'] });
    st().openDocker(API);
    expect(focus).toHaveBeenCalledWith('dk:c:aaaaaaaaaaaa');
    expect(st().space).toBe('sessions');
    (globalThis as { window: { atelier: unknown } }).window.atelier = {};
  });

  test('a container shown from a notification or main (openContainer) while in Databases lands in Docker', () => {
    st().openDbTab(table('orders'), { preview: false });
    openContainer('aaaaaaaaaaaa', 'inspect');
    expect(st().space).toBe('docker');
    expect(st().activity).toBe('docker');
    expect(st().dockerTabs).toMatchObject([{ key: 'dk:c:aaaaaaaaaaaa', view: 'inspect' }]);
  });

  test('Changes (its shortcut) from another space: Sessions comes forward with it shown, never hidden by it', () => {
    useApp.setState({ showChanges: true });
    st().openDocker(API);
    st().toggleChanges();
    expect(st().space).toBe('sessions');
    expect(st().showChanges).toBe(true);
    useApp.setState({ showChanges: false });
    st().openDocker(API);
    st().toggleChanges();
    expect([st().space, st().showChanges]).toEqual(['sessions', true]);
    st().toggleChanges();
    expect(st().showChanges).toBe(false);
  });

  test('Back to terminal (⌘0) from another space goes to Sessions', () => {
    st().openDocker(API);
    st().showTerminal();
    expect(st().space).toBe('sessions');
    expect(st().activeKey()).toBe('t:a');
  });
});

describe('entering a space with no tab', () => {
  const auto = (id: string, project: string): AutomationView => ({ automation: { id, project, name: id } }) as unknown as AutomationView;
  afterEach(() => { useDb.setState({ snap: EMPTY_DB_SNAPSHOT }); });

  test('Docker opens its Overview, Redis its Keys', () => {
    st().setActivity('docker');
    expect(st().tabOrder).toEqual(k('dk:overview'));
    expect(st().dockerPreview).toBeNull();
    st().setActivity('redis');
    expect(st().tabOrder).toEqual(k('rd:keys'));
  });

  test('Automations opens this project’s first automation, else every project’s list, else nothing', () => {
    useApp.setState({ automations: { automations: [auto('x1', '/other'), auto('a1', '/p'), auto('a2', '/p')] } });
    st().setActivity('automations');
    expect(st().tabOrder).toEqual(k('au:a1'));
    st().closeTab('au:a1');
    st().setActivity('sessions');
    useApp.setState({ automations: { automations: [auto('x1', '/other')] } });
    st().setActivity('automations');
    expect(st().tabOrder).toEqual(k('au:all'));
    st().closeTab('au:all');
    st().setActivity('sessions');
    useApp.setState({ automations: { automations: [] } });
    st().setActivity('automations');
    expect(st().tabOrder).toEqual([]);
    expect(st().activeTab).toBe('none');
  });

  test('Databases opens nothing by itself, even with one connection: its empty state (the sidebar connects and reads the catalog)', () => {
    st().setActivity('databases');
    expect(st().tabOrder).toEqual([]);
    st().setActivity('sessions');
    // An overview read would connect it on demand first, and the sidebar's connect (the one that reads the catalog) would
    // then find it connected and skip: the catalog never came (e2e databases-connect).
    useDb.setState({ snap: { ...EMPTY_DB_SNAPSHOT, connections: [{ conn: { id: 'c0123456789ab' } }] as never } });
    st().setActivity('databases');
    expect(st().tabOrder).toEqual([]);
    expect(st().activeTab).toBe('none');
  });

  test('closing the last tab opens nothing by itself; coming back in opens the default again', () => {
    st().setActivity('docker');
    st().closeTab('dk:overview');
    expect(st().tabOrder).toEqual([]);
    expect(st().activeTab).toBe('none');
    st().setActivity('docker');
    expect(st().tabOrder).toEqual([]);
    st().setActivity('sessions');
    st().setActivity('docker');
    expect(st().tabOrder).toEqual(k('dk:overview'));
  });

  test('a tab opened from elsewhere brings no default along', () => {
    st().openRedis('live');
    expect(st().tabOrder).toEqual(k('rd:live'));
  });
});

describe('nothing in front of another space is never a terminal', () => {
  test('closing the last Docker tab leaves Docker empty, the selection unchanged', () => {
    st().openDocker(API);
    st().closeTab('dk:c:aaaaaaaaaaaa');
    expect(st().space).toBe('docker');
    expect(st().activeTab).toBe('none');
    expect(st().activeKey()).toBeNull();
    expect(st().selectedId).toBe('a');
  });

  test('the selection stays the session you were on while you look at another space', () => {
    st().select('b');
    st().openDocker(API);
    expect(st().selectedId).toBe('b');
  });
});

describe('what arrives by itself', () => {
  test('a terminal created while in Docker stays out of Docker’s strip, and is in Sessions after the front', () => {
    st().openDocker(API);
    st().setTerminals([T.a, T.b, T.c]);
    expect(st().tabOrder).toEqual(k('dk:c:aaaaaaaaaaaa'));
    expect(st().space).toBe('docker');
    st().setActivity('sessions');
    expect(st().tabOrder).toEqual(k('t:a', 't:c', 't:b'));
    expect(st().activeKey()).toBe('t:a');
  });

  test('the session in front exits while in Docker: back in Sessions, its neighbour is in front', () => {
    st().openDocker(API);
    st().setTerminals([T.b]);
    expect(st().selectedId).toBeNull();
    st().setActivity('sessions');
    expect(st().tabOrder).toEqual(k('t:b'));
    expect(st().activeKey()).toBe('t:b');
  });

  test('a file renamed while in Docker keeps its tab in Sessions', () => {
    st().openFile('/p/x.ts', 'x.ts');
    st().openDocker(API);
    st().renameOpenFiles('/p/x.ts', '/p/y.ts', '/p');
    st().setActivity('sessions');
    expect(st().tabOrder).toContain('f:/p/y.ts');
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
  });

  test('a Docker tab closed for good while in Sessions goes from Docker (Settings › Docker › Never)', () => {
    st().openDocker(API);
    st().setActivity('sessions');
    st().closeTab('dk:c:aaaaaaaaaaaa');
    expect(st().dockerTabs).toEqual([]);
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
    // Back in Docker: the container's tab is gone (it opens its Overview, as an empty Docker does).
    st().setActivity('docker');
    expect(st().tabOrder).toEqual(k('dk:overview'));
  });
});

describe('what is saved stays Sessions’', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('a split made in Databases never replaces the Sessions layout saved for the project', () => {
    vi.useFakeTimers();
    useApp.setState({ layoutRestored: true });
    st().openDbTab(table('orders'), { preview: false });
    st().openDbTab(table('users'), { preview: false });
    st().moveTabToNewPane(USERS, 0, 'right');
    vi.advanceTimersByTime(LAYOUT_SAVE_MS + 50);
    expect(savedKeys(loadSplitLayout('/p'))).not.toContain(USERS);
  });
});

describe('a session or terminal asked for', () => {
  test('⌘T from Docker: Sessions comes forward at once; gone to Docker before it is there, it never pulls you back', async () => {
    let reply: (t: TerminalInfo) => void = () => {};
    (globalThis as { window: { atelier: unknown } }).window.atelier = { terminals: { create: () => new Promise<TerminalInfo>((r) => { reply = r; }) } };
    st().openDocker(API);
    const made = newTerminalIn();
    expect(st().space).toBe('sessions');
    st().setActivity('docker');
    reply(T.c);
    await made;
    expect(st().space).toBe('docker');
    expect(st().tabOrder).toEqual(k('dk:c:aaaaaaaaaaaa'));
    st().setActivity('sessions');
    expect(st().tabOrder).toContain('t:c');
    (globalThis as { window: { atelier: unknown } }).window.atelier = {};
  });

  test('still in Sessions when it is there: it comes to the front, as before', async () => {
    (globalThis as { window: { atelier: unknown } }).window.atelier = { terminals: { create: async () => T.c } };
    await newTerminalIn();
    expect(st().activeKey()).toBe('t:c');
    (globalThis as { window: { atelier: unknown } }).window.atelier = {};
  });
});

describe('workspaces partition Sessions only', () => {
  const ws = (): WorkspacesState => ({
    on: true, active: 'A',
    list: [
      { id: 'A', name: 'A', color: 1, folder: null, order: k('t:a'), active: 't:a', layout: null },
      { id: 'B', name: 'B', color: 2, folder: null, order: k('t:b'), active: 't:b', layout: null }
    ],
    members: { a: 'A', b: 'B' }
  });

  test('switching workspace from Docker lands in Sessions, in that workspace', () => {
    useApp.setState({ ws: ws(), tabOrder: k('t:a'), selectedId: 'a', activeTab: 'term' });
    st().openDocker(API);
    st().switchWorkspace('B');
    expect(st().space).toBe('sessions');
    expect(st().tabOrder).toEqual(k('t:b'));
  });

  test('in another space, what workspaces save is still Sessions’ tabs (never emptied by Docker’s strip)', () => {
    useApp.setState({ ws: ws(), tabOrder: k('t:a'), selectedId: 'a', activeTab: 'term' });
    st().openDocker(API);
    const saved = st().workspacesNow()!;
    expect(saved.list.find((w) => w.id === 'A')).toMatchObject({ order: k('t:a'), active: 't:a' });
  });

  test('tables are no workspace’s: a workspace switch leaves Databases as it was', () => {
    useApp.setState({ ws: ws(), tabOrder: k('t:a'), selectedId: 'a', activeTab: 'term' });
    st().openDbTab(table('orders'), { preview: false });
    st().switchWorkspace('B');
    expect(st().ws!.list.every((w) => w.order.every((x) => !x.startsWith('db:')))).toBe(true);
    st().setActivity('databases');
    expect(st().tabOrder).toEqual(k(ORDERS));
  });
});

// A change to a space not in front is made to its saved view, never by bringing it forward
// for a moment — every subscriber would see that moment (the seen-check, the tab history, a drag, an empty pane).

/** The spaces other than `space` any state change showed while `fn` ran: none, for a change made in the background. */
function othersSeen(space: string, fn: () => void): string[] {
  const seen: string[] = [];
  const off = useApp.subscribe((s) => { if (s.space !== space) seen.push(s.space); });
  try { fn(); } finally { off(); }
  return seen;
}
const atelier = (api: unknown) => { (g.window as { atelier: unknown }).atelier = api; };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a space not in front changes without coming forward', () => {
  afterEach(() => { atelier({}); });

  test('a file renamed while in Docker: Docker stays, the selection too; back in Sessions the tab is renamed in place', () => {
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: false });
    st().openDocker(API);
    expect(othersSeen('docker', () => st().renameOpenFiles('/p/x.ts', '/p/y.ts', '/p'))).toEqual([]);
    expect(st().selectedId).toBe('a');
    st().setActivity('sessions');
    expect(st().tabOrder).toEqual(k('t:a', 'f:/p/y.ts', 't:b'));
    expect(st().activeKey()).toBe('f:/p/y.ts');
  });

  test('the Background tab’s terminal ends while in Docker: nothing shows a terminal meanwhile; back in Sessions the tab is gone', () => {
    st().setTerminals([T.a, T.b, T.c]);
    st().openBackground({ terminalId: 'c', here: true });
    st().select('a');
    st().openDocker(API);
    const terms: string[] = [];
    const off = useApp.subscribe((s) => { if (s.activeTab === 'term' && s.selectedId) terms.push(s.selectedId); });
    expect(othersSeen('docker', () => st().setTerminals([T.a, T.b]))).toEqual([]);
    off();
    expect(terms).toEqual([]);
    st().setActivity('sessions');
    expect(st().tabOrder).not.toContain('background');
    expect(st().activeKey()).toBe('t:a');
  });

  test('an automation removed while Docker shows an empty pane: Docker’s panes stay as they are', () => {
    const auto = (id: string) => ({ automation: { id, project: '/p', name: id } }) as unknown as AutomationView;
    useApp.setState({ automations: { automations: [auto('a1')] } });
    st().openAutomations('a1');
    st().openDocker(API, undefined, { preview: false });
    st().splitRight();
    const before = st().split;
    expect(othersSeen('docker', () => st().setAutomations({ automations: [] }))).toEqual([]);
    expect(st().split).toBe(before);
    st().setActivity('automations');
    expect(st().tabOrder).toEqual([]);
  });

  test('a table closed for good from Sessions (its connection removed): Databases forgets it, its front goes to the one used before', () => {
    const ITEMS = 'db:c0123456789ab/public/items' as TabKey;
    st().openDbTab(table('orders'), { preview: false });
    st().openDbTab(table('users'), { preview: false });
    st().openDbTab(table('items'), { preview: false });
    st().activate(ORDERS);
    st().activate(ITEMS);
    st().setActivity('sessions');
    expect(othersSeen('sessions', () => st().closeDbTabs((r) => r.key === ITEMS))).toEqual([]);
    expect(st().dbTabs.map((r) => r.key)).toEqual([ORDERS, USERS]);
    st().setActivity('databases');
    expect(st().tabOrder).toEqual(k(ORDERS, USERS));
    // The one used before it, not its neighbour.
    expect(st().activeKey()).toBe(ORDERS);
  });

  test('a file trashed while in Docker: Docker stays; back in Sessions its tab is gone and the one used before is in front', () => {
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: false });
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: false });
    st().openFile('/p/z.ts', 'z.ts', null, undefined, { preview: false });
    st().openFile('/p/x.ts', 'x.ts');
    st().openDocker(API);
    expect(othersSeen('docker', () => st().dropOpenFiles('/p/x.ts'))).toEqual([]);
    st().setActivity('sessions');
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
    expect(st().activeKey()).toBe('f:/p/z.ts');
  });

  test('the Sessions layout saved for the project waits for Sessions: a split in Docker meanwhile neither cancels nor replaces it', () => {
    saveSplitLayout('/p', { v: 2, panes: [{ tabs: k('t:a'), front: 't:a' }, { tabs: k('t:b'), front: 't:b' }], fractions: [0.5, 0.5], focus: 0 });
    useApp.setState({ layoutRestored: false, tabsRestored: true, daemon: { ...st().daemon, listed: true } });
    st().openDocker(API, undefined, { preview: false });
    st().splitRight();
    expect(othersSeen('docker', () => st().setTerminals([T.a, T.b]))).toEqual([]);
    expect(st().space).toBe('docker');
    st().setActivity('sessions');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:a'), k('t:b')]);
  });

  test('workspaces turned on from another space (the menu, the palette): Sessions comes forward with them', () => {
    st().openDocker(API);
    st().setWorkspacesOn(true);
    expect(st().space).toBe('sessions');
    expect(st().ws?.on).toBe(true);
    expect(st().tabOrder).toEqual(k('t:a', 't:b'));
  });

  test('“in every project” turned on while in another space: nothing switches; Sessions has them when it comes back', () => {
    const everywhere = (on: boolean) => useApp.setState({ settings: { ...st().settings, workspacesEverywhere: on } });
    try {
      st().openDocker(API);
      everywhere(true);
      expect(othersSeen('docker', () => st().applyWorkspacesEverywhere())).toEqual([]);
      st().setActivity('sessions');
      expect(st().ws?.on).toBe(true);
    } finally { everywhere(false); }
  });
});

describe('coming back to Sessions', () => {
  test('with a file in front: the selection is still the session you were on', () => {
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: false });
    expect(st().tabOrder).toEqual(k('t:a', 'f:/p/x.ts', 't:b'));
    st().setActivity('docker');
    st().setActivity('sessions');
    expect(st().activeKey()).toBe('f:/p/x.ts');
    expect(st().selectedId).toBe('a');
  });

  test('closing a tab gives the front to the one used before it, as without the round trip', () => {
    st().setTerminals([T.a, T.b, T.c]);
    st().select('b');
    st().select('a');
    expect(st().tabOrder).toEqual(k('t:a', 't:c', 't:b'));
    st().setActivity('docker');
    st().setActivity('sessions');
    st().closeTab('t:a');
    expect(st().activeKey()).toBe('t:b');
  });

  test('an empty pane made in a space is still there when you come back', () => {
    st().openDocker(API, undefined, { preview: false });
    st().openDocker({ kind: 'overview' }, undefined, { preview: false });
    st().splitRight();
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('dk:c:aaaaaaaaaaaa', 'dk:overview'), []]);
    st().setActivity('sessions');
    st().setActivity('docker');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('dk:c:aaaaaaaaaaaa', 'dk:overview'), []]);
    expect(st().split.focus).toBe(1);
  });
});

describe('Sessions’ own actions from another space', () => {
  afterEach(() => { atelier({}); useApp.setState({ resumables: [], bulkResume: null, saveAs: null }); });

  test('New File from Docker opens in Sessions; Docker’s strip keeps its own tabs', () => {
    st().openDocker(API);
    st().newUntitled();
    expect(st().space).toBe('sessions');
    expect(st().tabOrder.some((x) => x.startsWith('f:'))).toBe(true);
    expect(st().spaceViews.docker.order).toEqual(k('dk:c:aaaaaaaaaaaa'));
  });

  test('an untitled tab saved as a file while in Docker keeps its tab in Sessions, with its new name', async () => {
    atelier({ files: { saveAs: async () => ({ path: '/p/notes.md' }) } });
    st().newUntitled();
    const untitled = st().activeTab;
    st().openDocker(API);
    const p = st().requestSaveAs(untitled, () => 'hello');
    await st().submitSaveAs('notes.md');
    await p;
    expect(st().space).toBe('docker');
    st().setActivity('sessions');
    expect(st().tabOrder).toContain('f:/p/notes.md');
    expect(st().activeKey()).toBe('f:/p/notes.md');
  });

  test('Resume (the palette) from Docker: Sessions comes forward at once; gone back to Docker before it is there, it stays', async () => {
    let reply: (t: TerminalInfo) => void = () => {};
    atelier({ terminals: { resume: () => new Promise<TerminalInfo>((r) => { reply = r; }) } });
    st().openDocker(API);
    const p = st().resume('old');
    expect(st().space).toBe('sessions');
    st().setActivity('docker');
    reply(term('n', 9));
    await p;
    expect(st().space).toBe('docker');
    st().setActivity('sessions');
    expect(st().tabOrder).toContain('t:n');
  });

  test('Resume All: gone to Docker while a session comes back, Docker stays in front', async () => {
    const replies = new Map<string, (t: TerminalInfo) => void>();
    atelier({ terminals: { resume: (id: string) => new Promise<TerminalInfo>((r) => { replies.set(id, r); }) } });
    st().setResumables([{ id: 'r', projectRoot: '/p', cwd: '/p', title: 'r', color: '#fff', sessionId: 's-r', endedAt: 0 }]);
    const done = st().resumeAll('all');
    await tick();
    expect(st().space).toBe('sessions');
    st().openDocker(API);
    replies.get('r')!(term('n', 9));
    await tick();
    expect(st().space).toBe('docker');
    st().stopResumeAll();
    await done;
    expect(st().space).toBe('docker');
  });
});
