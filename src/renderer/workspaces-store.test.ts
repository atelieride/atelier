import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { flatten, isSplit, single } from './split';
import type { TabKey } from './tabs-model';
import { isOpen, isProjectKey, type WorkspacesState } from './workspaces';

// Workspaces in the store: the strip is the active workspace's; switching swaps it; every
// way to a session in another workspace switches first; off is exactly today.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
const stopped: string[][] = [];
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = { addEventListener: () => {}, atelier: { terminals: { stop: async (ids: string[]) => { stopped.push(ids); } } } };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

const term = (id: string, createdAt: number): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null
});
const st = () => useApp.getState();
const k = (...keys: string[]) => keys as TabKey[];
const T = { auth: term('auth', 1), tok: term('tok', 2), bill: term('bill', 3) };
const ALL = [T.auth, T.tok, T.bill];

function wsAB(on = true): WorkspacesState {
  return {
    on, active: 'A',
    list: [
      { id: 'A', name: 'Auth', color: 1, folder: null, order: k('t:auth', 't:tok'), active: 't:auth', layout: null },
      { id: 'B', name: 'Billing', color: 2, folder: null, order: k('t:bill'), active: 't:bill', layout: null }
    ],
    members: { auth: 'A', tok: 'A', bill: 'B' }
  };
}

/** Every invariant at once. */
function invariant() {
  const s = st();
  if (!s.ws?.on) return;
  const ids = s.terminals.map((x) => x.id);
  for (const id of ids) expect(s.ws.list.map((w) => w.id)).toContain(s.ws.members[id]);
  for (const key of s.tabOrder) if (key.startsWith('t:')) expect(s.ws.members[key.slice(2)]).toBe(s.ws.active);
  // The project views after the own tabs: of the whole strip, or of each pane's strip in a split.
  const strips = isSplit(s.split) ? s.split.panes.map((p) => p.tabs) : [s.tabOrder];
  for (const strip of strips) {
    const firstProject = strip.findIndex(isProjectKey);
    if (firstProject >= 0) expect(strip.slice(firstProject).every(isProjectKey)).toBe(true);
  }
  if (isSplit(s.split)) expect(s.tabOrder).toEqual(flatten(s.split));
}

beforeEach(() => {
  stopped.length = 0;
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [],
    openFiles: [], preview: null, pendingAnchor: null, review: null, servicesOpen: false, split: single(), toast: null, dirty: {}, ws: null,
    resumables: [], resumablesKnown: false
  });
});

describe('off is today', () => {
  test('no workspaces: every terminal gets a tab, as before', () => {
    st().setTerminals(ALL);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
    expect(st().selectedId).toBe('bill');
  });
  test('workspaces saved but off: their memberships change nothing', () => {
    useApp.setState({ ws: wsAB(false) });
    st().setTerminals(ALL);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
    st().select('auth');
    expect(st().ws!.active).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
  });
});

describe('on: the strip is the active workspace', () => {
  test('only the active workspace\'s terminals have tabs', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok'));
    expect(st().selectedId).toBe('tok');
    invariant();
  });
  test('a new terminal lands in the active workspace and belongs to it', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().setTerminals([...ALL, term('new', 4)]);
    expect(st().ws!.members.new).toBe('A');
    expect(st().tabOrder).toContain('t:new');
    invariant();
  });
  test('the project views stay after the workspace\'s tabs', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().openServices();
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 'services'));
    invariant();
  });
});

describe('switching', () => {
  test('swaps the strip, keeps the project views, shows the incoming front; the outgoing keeps its order and front', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().openServices();
    st().select('tok');
    st().switchWorkspace('B');
    expect(st().ws!.active).toBe('B');
    expect(st().tabOrder).toEqual(k('t:bill', 'services'));
    expect(st().activeKey()).toBe('t:bill');
    expect(st().ws!.list[0]).toMatchObject({ order: k('t:auth', 't:tok'), active: 't:tok' });
    invariant();
    st().switchWorkspace('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 'services'));
    expect(st().activeKey()).toBe('t:tok');
    invariant();
  });
  test('a live terminal of the incoming workspace missing from its saved order (back from a pop-out) gets its tab at once', () => {
    useApp.setState({ ws: { ...wsAB(), list: wsAB().list.map((w) => (w.id === 'B' ? { ...w, order: [], active: null } : w)) } });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill'));
    expect(st().activeKey()).toBe('t:bill');
  });
  test('a switch before the saved tabs are back keeps the outgoing workspace\'s files that are not open yet', () => {
    const withFile = { ...wsAB(), list: wsAB().list.map((w) => (w.id === 'A' ? { ...w, order: k('t:auth', 't:tok', 'f:/p/x.ts') } : w)) };
    useApp.setState({ ws: withFile, tabsRestored: false });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    expect(st().ws!.list[0]!.order).toContain('f:/p/x.ts');
    // Once restored, a file no longer open is one closed meanwhile: it goes.
    useApp.setState({ ws: withFile, tabsRestored: true, tabOrder: k('t:auth', 't:tok') });
    st().switchWorkspace('B');
    expect(st().ws!.list[0]!.order).not.toContain('f:/p/x.ts');
  });
  test('each workspace keeps its own split (every pane\'s tabs)', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().splitRight();
    st().select('tok');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth'), k('t:tok')]);
    st().switchWorkspace('B');
    expect(st().split.panes).toHaveLength(1);
    st().switchWorkspace('A');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth'), k('t:tok')]);
    expect(st().activeKey()).toBe('t:tok');
    invariant();
  });
  test('Review Focus 4: a project view in pane 2 of A is in B\'s only strip while in B, back in pane 2 in A; never in two strips', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().splitRight();
    st().select('tok');
    st().openServices();
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth'), k('t:tok', 'services')]);
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill', 'services'));
    st().switchWorkspace('A');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth'), k('t:tok', 'services')]);
    expect(st().tabOrder.filter((x) => x === 'services')).toHaveLength(1);
    invariant();
  });
  test('the project views stay after each pane\'s own tabs', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().splitRight();
    st().select('tok');
    st().openServices();
    st().focusPane(0);
    st().openReview('all');
    st().openFile('/p/x.ts', 'x.ts');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth', 'f:/p/x.ts', 'review'), k('t:tok', 'services')]);
    expect(st().tabOrder).toEqual(k('t:auth', 'f:/p/x.ts', 'review', 't:tok', 'services'));
    invariant();
  });
  test('off with a split: the active workspace\'s panes stay; the others\' tabs join the focused pane', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().splitRight();
    st().select('tok');
    st().setWorkspacesOn(false);
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:auth'), k('t:tok', 't:bill')]);
    expect(st().activeKey()).toBe('t:tok');
  });
  test('off with a split in a later workspace: the earlier workspaces\' tabs go after the focused pane\'s own', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().moveTabStep(1);
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:bill'), k('f:/p/x.ts')]);
    st().setWorkspacesOn(false);
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:bill'), k('f:/p/x.ts', 't:auth', 't:tok')]);
    expect(st().activeKey()).toBe('f:/p/x.ts');
    expect(st().tabOrder).toEqual(flatten(st().split));
  });
  test('selecting a terminal of another workspace switches first (sidebar, ⌘J, notifications, palette, Dock)', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('bill');
    expect(st().ws!.active).toBe('B');
    expect(st().tabOrder).toEqual(k('t:bill'));
    expect(st().activeKey()).toBe('t:bill');
    invariant();
  });
  test('a workspace with nothing open shows the empty state, its project views still there', () => {
    useApp.setState({ ws: { ...wsAB(), list: [...wsAB().list, { id: 'C', name: 'Hotfix', color: 3, folder: null, order: [], active: null, layout: null }] } });
    st().setTerminals(ALL);
    st().openServices();
    st().switchWorkspace('C');
    expect(st().tabOrder).toEqual(k('services'));
    expect(st().activeKey()).toBeNull();
  });
  test('opening a file never switches: it opens in the active workspace', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    expect(st().ws!.active).toBe('A');
    expect(st().tabOrder).toContain('f:/p/x.ts');
  });
  test('switching to the active one, to an unknown one, or with workspaces off does nothing', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    const before = st().tabOrder;
    st().switchWorkspace('A');
    st().switchWorkspace('nope');
    expect(st().tabOrder).toBe(before);
    useApp.setState({ ws: wsAB(false) });
    st().switchWorkspace('B');
    expect(st().ws!.active).toBe('A');
  });
  test('the chevron folds or opens a workspace without switching; the one you go to opens, the one you leave stays as it was', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    const before = st().tabOrder;
    st().toggleWorkspaceOpen('B');
    expect(st().ws!.active).toBe('A');
    expect(st().tabOrder).toBe(before);
    expect(st().ws!.list[1]!.open).toBe(true);
    st().toggleWorkspaceOpen('B');
    expect(st().ws!.list[1]!.open).toBe(false);
    st().switchWorkspace('B');
    expect(st().ws!.list[1]!.open).toBeUndefined();
    // The one left stays open (revised 2026-11-08): switching never folds a workspace, only its chevron does.
    expect(st().ws!.list[0]!.open).toBe(true);
    expect(isOpen(st().ws!, 'A')).toBe(true);
    // Off, the chevrons do nothing.
    useApp.setState({ ws: wsAB(false) });
    st().toggleWorkspaceOpen('B');
    expect(st().ws!.list[1]!.open).toBeUndefined();
  });
});

describe('moving a tab to another workspace', () => {
  test('a terminal leaves the strip (its neighbour comes forward) and is in the target', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('tok');
    st().moveToWorkspace('t:tok', 'B');
    expect(st().tabOrder).toEqual(k('t:auth'));
    expect(st().activeKey()).toBe('t:auth');
    expect(st().ws!.members.tok).toBe('B');
    invariant();
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill', 't:tok'));
  });
  test('a move says where it went, with Go to bring that workspace forward', () => {
    useApp.setState({ ws: wsAB(), toast: null });
    st().setTerminals(ALL);
    st().moveToWorkspace('t:tok', 'B');
    expect(st().toast?.text).toBe('Moved to Billing');
    st().toast!.action!.run();
    expect(st().ws!.active).toBe('B');
  });
  test('a terminal whose tab is closed (its row still in the sidebar) moves too', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().closeTab('t:tok');
    expect(st().tabOrder).toEqual(k('t:auth'));
    st().moveToWorkspace('t:tok', 'B');
    expect(st().ws!.members.tok).toBe('B');
  });
  test('a row of a workspace not in front (open in the sidebar) moves too; into the active one it gets its tab', () => {
    const three: WorkspacesState = { ...wsAB(), list: [...wsAB().list, { id: 'C', name: 'Hotfix', color: 3, folder: null, order: [], active: null, layout: null }] };
    useApp.setState({ ws: three, toast: null });
    st().setTerminals(ALL);
    st().moveToWorkspace('t:bill', 'C');
    expect(st().ws!.members.bill).toBe('C');
    expect(st().ws!.list.find((w) => w.id === 'B')!.order).toEqual([]);
    expect(st().ws!.list.find((w) => w.id === 'C')!.order).toEqual(k('t:bill'));
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok'));
    expect(st().toast?.text).toBe('Moved to Hotfix');
    st().moveToWorkspace('t:bill', 'A');
    expect(st().ws!.members.bill).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
    invariant();
    // Onto its own workspace: nothing happens.
    const before = st().ws;
    st().moveToWorkspace('t:bill', 'A');
    expect(st().ws).toBe(before);
  });
  test('Open to the Side on a row of another workspace (⌥-click, its menu) brings that workspace forward first: never a foreign tab in this strip', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('auth');
    st().openToSide('t:bill');
    expect(st().ws!.active).toBe('B');
    expect(st().tabOrder).toContain('t:bill');
    expect(st().tabOrder).not.toContain('t:auth');
    expect(st().ws!.members.bill).toBe('B');
    expect(JSON.stringify(st().split)).not.toContain('t:auth');
    expect(st().activeKey()).toBe('t:bill');
    expect(st().ws!.list[0]!.order).not.toContain('t:bill');
    invariant();
  });
  test('a file moved away stays open: the target shows it', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    st().moveToWorkspace('f:/p/x.ts', 'B');
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
    st().switchWorkspace('B');
    expect(st().tabOrder).toContain('f:/p/x.ts');
  });
});

describe('files are shared', () => {
  test('a file open in two workspaces closes in one and stays open in the other', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().closeTab('/p/x.ts');
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
    st().switchWorkspace('A');
    expect(st().tabOrder).toContain('f:/p/x.ts');
    st().closeTab('/p/x.ts');
    expect(st().openFiles).toEqual([]);
  });
  test('a preview replaced here stays open when another workspace shows that file', () => {
    useApp.setState({ ws: wsAB(), settings: { ...st().settings, previewTabs: true } });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('A');
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    st().openFile('/p/z.ts', 'z.ts', null, undefined, { preview: true });
    expect(st().openFiles.map((f) => f.path).sort()).toEqual(['/p/x.ts', '/p/z.ts']);
    st().switchWorkspace('B');
    expect(st().tabOrder).toContain('f:/p/x.ts');
  });
  test('a preview replaced by a file another workspace has open leaves no editor behind', () => {
    useApp.setState({ ws: wsAB(), settings: { ...st().settings, previewTabs: true } });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('A');
    st().openFile('/p/y.ts', 'y.ts', null, undefined, { preview: true });
    st().openFile('/p/x.ts', 'x.ts', null, undefined, { preview: true });
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
  });
  test('a file renamed while its workspace is not in front keeps its tab there', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('A');
    st().renameOpenFiles('/p/x.ts', '/p/y.ts', '/p');
    st().switchWorkspace('B');
    expect(st().tabOrder).toContain('f:/p/y.ts');
    expect(st().activeKey()).toBe('f:/p/y.ts');
  });
  test('a file popped out into its own window leaves every workspace\'s editor here, even one another workspace shows', () => {
    useApp.setState({ ws: wsAB(), poppedOut: [] });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('A');
    st().applyPoppedOut(['f:/p/x.ts']);
    expect(st().openFiles).toEqual([]);
    st().switchWorkspace('B');
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
    useApp.setState({ poppedOut: [] });
  });
  test('an unsaved file shown in another workspace closes here without asking', async () => {
    const ask = vi.fn(async () => 'cancel' as const);
    useApp.setState({ ws: wsAB(), askUnsaved: ask as never });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    st().switchWorkspace('B');
    st().openFile('/p/x.ts', 'x.ts');
    useApp.setState({ dirty: { '/p/x.ts': true } });
    await st().closeTabs(k('f:/p/x.ts'));
    expect(ask).not.toHaveBeenCalled();
    expect(st().tabOrder).not.toContain('f:/p/x.ts');
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/x.ts']);
  });
});

describe('off and on again', () => {
  test('the first time on: everything is in Workspace 1', () => {
    st().setTerminals(ALL);
    st().openServices();
    st().setWorkspacesOn(true);
    const ws = st().ws!;
    expect(ws.on).toBe(true);
    expect(ws.list).toHaveLength(1);
    expect(ws.list[0]!.name).toBe('Workspace 1');
    expect(Object.keys(ws.members).sort()).toEqual(['auth', 'bill', 'tok']);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill', 'services'));
    invariant();
  });
  test('off: one strip with every workspace\'s tabs; nothing closes, the front stays', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    st().select('tok');
    st().setWorkspacesOn(false);
    expect(st().ws!.on).toBe(false);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 'f:/p/x.ts', 't:bill'));
    expect(st().activeKey()).toBe('t:tok');
    expect(st().terminals).toHaveLength(3);
  });
  test('off: tabs another workspace kept for files that are gone leave no ghost in the strip', () => {
    useApp.setState({ ws: { ...wsAB(), list: wsAB().list.map((w) => (w.id === 'B' ? { ...w, order: k('t:bill', 'f:/p/trashed.ts') } : w)) } });
    st().setTerminals(ALL);
    st().setWorkspacesOn(false);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
  });
  test('the first time on: a project view among the tabs moves after them', () => {
    st().setTerminals(ALL);
    useApp.setState({ tabOrder: k('t:auth', 'services', 't:tok', 't:bill') });
    st().setWorkspacesOn(true);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill', 'services'));
  });
  test('on again: each tab goes back to its workspace; what was opened while off joins the active one', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().setWorkspacesOn(false);
    st().setTerminals([...ALL, term('later', 9)]);
    st().setWorkspacesOn(true);
    expect(st().ws!.members.later).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:later'));
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill'));
    invariant();
  });
});

describe('⌘J', () => {
  const waiting = (id: string, createdAt: number): TerminalInfo => ({ ...term(id, createdAt), session: { sessionId: id, state: 'waiting', waitingFor: 'permission', unread: false, updatedAt: 0 } as unknown as TerminalInfo['session'] });
  test('follows a waiting session into another workspace (the default)', async () => {
    const { goToAttention } = await import('./attention-nav');
    useApp.setState({ ws: wsAB(), settings: { ...st().settings, wsJumpFollows: true } });
    st().setTerminals([T.auth, T.tok, waiting('bill', 3)]);
    st().select('auth');
    goToAttention();
    expect(st().ws!.active).toBe('B');
    expect(st().activeKey()).toBe('t:bill');
  });
  test('with "follows" off it stays in the active workspace', async () => {
    const { goToAttention } = await import('./attention-nav');
    useApp.setState({ ws: wsAB(), settings: { ...st().settings, wsJumpFollows: false } });
    st().setTerminals([T.auth, T.tok, waiting('bill', 3)]);
    st().select('auth');
    goToAttention();
    expect(st().ws!.active).toBe('A');
    expect(st().activeKey()).toBe('t:auth');
  });
});

describe('Resume', () => {
  const res = (id: string) => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: id, endedAt: 1 });
  test('Resume all and Dismiss All act on the active workspace\'s sessions only', async () => {
    const resumed: string[] = [];
    const dismissed: string[] = [];
    const api = (g.window as { atelier: { terminals: Record<string, unknown> } }).atelier.terminals;
    api.resume = async (id: string) => { resumed.push(id); return { ...term(`${id}2`, 9), session: { state: 'idle' } as unknown as TerminalInfo['session'] }; };
    api.dismiss = async (id: string) => { dismissed.push(id); };
    useApp.setState({ ws: { ...wsAB(), members: { ...wsAB().members, oldA: 'A', oldB: 'B' } }, resumables: [res('oldA'), res('oldB')], resumablesKnown: true });
    st().setTerminals(ALL);
    await st().resumeAll('all');
    expect(resumed).toEqual(['oldA']);
    expect(st().ws!.members.oldA2).toBe('A');
    await st().confirmDismissAll();
    expect(dismissed).toEqual(['oldA']);
  });
  test('a terminal of another workspace opened behind your back (Resume all after a switch) lands there; you stay', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().opened(T.auth);
    expect(st().ws!.active).toBe('B');
    expect(st().activeKey()).toBe('t:bill');
  });
  test('a session resumed from elsewhere (the palette) brings its workspace forward', async () => {
    const api = (g.window as { atelier: { terminals: Record<string, unknown> } }).atelier.terminals;
    api.resume = async (id: string) => term(`${id}2`, 9);
    useApp.setState({ ws: { ...wsAB(), members: { ...wsAB().members, oldB: 'B' } }, resumables: [res('oldB')], resumablesKnown: true });
    st().setTerminals(ALL);
    await st().resume('oldB');
    expect(st().ws!.active).toBe('B');
    expect(st().ws!.members.oldB2).toBe('B');
  });
});

describe('creating, closing', () => {
  test('a new workspace starts empty and becomes active', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    const id = st().newWorkspace({ name: 'DB migration' })!;
    expect(st().ws!.active).toBe(id);
    expect(st().tabOrder).toEqual([]);
    st().setTerminals([...ALL, term('db', 5)]);
    expect(st().ws!.members.db).toBe(id);
    expect(st().tabOrder).toEqual(k('t:db'));
  });
  test('New Workspace from Move to Workspace ›: made, the tab moves into it, then it comes to the front', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().select('tok');
    const id = st().newWorkspace({ name: 'Tokens' }, 't:tok')!;
    expect(st().ws!.active).toBe(id);
    expect(st().ws!.members.tok).toBe(id);
    expect(st().tabOrder).toEqual(k('t:tok'));
    expect(st().activeKey()).toBe('t:tok');
    st().switchWorkspace('A');
    expect(st().tabOrder).toEqual(k('t:auth'));
    invariant();
  });
  test('Close with Move: its terminals join the target; the active one closing switches there first', async () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    st().openFile('/p/x.ts', 'x.ts');
    await st().closeWorkspace('A', 'move');
    expect(st().ws!.list.map((w) => w.id)).toEqual(['B']);
    expect(st().ws!.active).toBe('B');
    expect(st().tabOrder).toEqual(k('t:bill', 't:auth', 't:tok'));
    expect(st().openFiles).toEqual([]);
    expect(stopped).toEqual([]);
    invariant();
  });
  test('Close with Stop: its terminals are stopped through main (resumable), their memberships go', async () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    await st().closeWorkspace('B', 'stop');
    expect(stopped).toEqual([['bill']]);
    expect(st().ws!.members.bill).toBeUndefined();
    expect(st().ws!.list.map((w) => w.id)).toEqual(['A']);
  });
  test('Close with an unsaved file: asked first; Cancel leaves the workspace, its file and its edits as they were', async () => {
    const ask = vi.fn(async () => 'cancel' as const);
    useApp.setState({ ws: wsAB(), askUnsaved: ask as never });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/inv.ts', 'inv.ts');
    useApp.setState({ dirty: { '/p/inv.ts': true } });
    st().switchWorkspace('A');
    await st().closeWorkspace('B', 'move');
    expect(ask).toHaveBeenCalledWith(['/p/inv.ts'], 'close', null);
    expect(st().ws!.list.map((w) => w.id)).toEqual(['A', 'B']);
    expect(st().openFiles.map((f) => f.path)).toEqual(['/p/inv.ts']);
    expect(st().dirty).toEqual({ '/p/inv.ts': true });
  });
  test('Close with an unsaved file and Don\'t Save: the file closes, its edits go', async () => {
    useApp.setState({ ws: wsAB(), askUnsaved: (async () => 'discard') as never });
    st().setTerminals(ALL);
    st().switchWorkspace('B');
    st().openFile('/p/inv.ts', 'inv.ts');
    useApp.setState({ dirty: { '/p/inv.ts': true } });
    st().switchWorkspace('A');
    await st().closeWorkspace('B', 'move');
    expect(st().ws!.list.map((w) => w.id)).toEqual(['A']);
    expect(st().openFiles).toEqual([]);
    expect(st().dirty).toEqual({});
  });
  test('Close with Stop: while they stop, its terminals show as closing and get no tab anywhere', async () => {
    useApp.setState({ ws: wsAB(), closing: {} });
    st().setTerminals(ALL);
    await st().closeWorkspace('B', 'stop');
    st().setTerminals(ALL);
    expect(st().tabOrder).not.toContain('t:bill');
    expect(st().closing.bill).toBe(true);
  });
  test('Close with Stop that main refuses: a notice; the terminals stay, shown again', async () => {
    const api = (g.window as { atelier: { terminals: Record<string, unknown> } }).atelier.terminals;
    const keep = api.stop;
    api.stop = async () => { throw new Error('refused'); };
    try {
      useApp.setState({ ws: wsAB(), closing: {}, toast: null });
      st().setTerminals(ALL);
      await st().closeWorkspace('B', 'stop');
      expect(st().toast?.text).toBeTruthy();
      expect(st().closing.bill).toBeUndefined();
    } finally { api.stop = keep; }
  });
  test('the last workspace cannot be closed', async () => {
    useApp.setState({ ws: { ...wsAB(), list: [wsAB().list[0]!], members: { auth: 'A', tok: 'A', bill: 'A' } } });
    st().setTerminals(ALL);
    await st().closeWorkspace('A', 'stop');
    expect(st().ws!.list).toHaveLength(1);
    expect(stopped).toEqual([]);
  });
  test('rename, recolor and Move Up keep everything else', () => {
    useApp.setState({ ws: wsAB() });
    st().renameWorkspace('B', 'Payments');
    st().recolorWorkspace('B', 6);
    st().moveWorkspace('B', -1);
    expect(st().ws!.list.map((w) => [w.id, w.name, w.color])).toEqual([['B', 'Payments', 6], ['A', 'Auth', 1]]);
    expect(st().ws!.active).toBe('A');
  });
});

// Settings › Appearance › Use workspaces in every project (2026-11-02): on, every project window has them, whatever
// its own switch says; off, each project decides again (one turned on only by the setting goes back off).
describe('on in every project', () => {
  const everywhere = (on: boolean) => useApp.setState({ settings: { ...st().settings, workspacesEverywhere: on } });
  afterEach(() => everywhere(false));

  test('a project that never used them turns on (marked as the setting\'s); turned off again, it goes back off', () => {
    st().setTerminals(ALL);
    everywhere(true);
    st().applyWorkspacesEverywhere();
    expect(st().ws).toMatchObject({ on: true, forced: true });
    expect(Object.keys(st().ws!.members).sort()).toEqual(['auth', 'bill', 'tok']);
    invariant();
    everywhere(false);
    st().applyWorkspacesEverywhere();
    expect(st().ws!.on).toBe(false);
    expect(st().ws!.forced).toBeUndefined();
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok', 't:bill'));
  });
  test('saved off with workspaces of its own: they come back while the setting is on, and go off with it', () => {
    useApp.setState({ ws: wsAB(false) });
    st().setTerminals(ALL);
    everywhere(true);
    st().applyWorkspacesEverywhere();
    expect(st().ws).toMatchObject({ on: true, forced: true, active: 'A' });
    expect(st().ws!.list.map((w) => w.name)).toEqual(['Auth', 'Billing']);
    expect(st().tabOrder).toEqual(k('t:auth', 't:tok'));
    everywhere(false);
    st().applyWorkspacesEverywhere();
    expect(st().ws!.on).toBe(false);
  });
  test('a project on by its own choice is left alone, and stays on when the setting goes off', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    everywhere(true);
    st().applyWorkspacesEverywhere();
    expect(st().ws!.forced).toBeUndefined();
    everywhere(false);
    st().applyWorkspacesEverywhere();
    expect(st().ws!.on).toBe(true);
  });
  test('while it is on, the project\'s own switch (Settings, View, palette) cannot turn them off', () => {
    useApp.setState({ ws: wsAB() });
    st().setTerminals(ALL);
    everywhere(true);
    st().setWorkspacesOn(false);
    expect(st().ws!.on).toBe(true);
  });
  test('a pop-out and the welcome window have no workspaces to turn on', () => {
    everywhere(true);
    useApp.setState({ project: null });
    st().applyWorkspacesEverywhere();
    expect(st().ws).toBeNull();
    useApp.setState({ project: { root: '/p', name: 'p', realRoot: '/p' }, popout: { key: 't:auth' } });
    st().applyWorkspacesEverywhere();
    expect(st().ws).toBeNull();
  });
});
