import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import { flatten, isSplit, single } from './split';
import type { TabKey } from './tabs-model';
import { isOpen, isProjectKey, workspaceOf, type WorkspacesState } from './workspaces';
import { goToWorkspaceAt, stepWorkspace } from './workspace-menus';
import { workspacesMenu } from './workspace-view';
import { newSessionIn, newTerminalIn } from './launch';

// Activities in the store: the strip is the place in front's; every way to a session inside an
// activity brings that activity forward; a way back to a workspace returns where it was left.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
const stopped: string[][] = [];
const created: Record<string, unknown>[] = [];
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  const reply = async (arg: Record<string, unknown>) => { created.push(arg); return term(`n${created.length}`, 50 + created.length); };
  g.window = { addEventListener: () => {}, atelier: { terminals: { stop: async (ids: string[]) => { stopped.push(ids); }, create: reply, createSession: reply } } };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

function term(id: string, createdAt: number, state: string | null = null): TerminalInfo {
  return {
    id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt,
    session: state ? ({ sessionId: id, state, waitingFor: state === 'waiting' ? 'permission' : undefined, unread: false, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
  };
}
const st = () => useApp.getState();
const k = (...keys: string[]) => keys as TabKey[];
const T = { auth: term('auth', 1), okta: term('okta', 2), mock: term('mock', 3), bill: term('bill', 4), hook: term('hook', 5) };
const ALL = [T.auth, T.okta, T.mock, T.bill, T.hook];

/** Auth (A: auth) with SSO (a1: okta, mock); Billing (B: bill, folder /p/wt) with Webhooks (b1: hook). A's own tabs in front. */
function wsActs(): WorkspacesState {
  return {
    on: true, active: 'A',
    list: [
      { id: 'A', name: 'Auth', color: 1, folder: null, order: k('t:auth'), active: 't:auth', layout: null },
      { id: 'B', name: 'Billing', color: 2, folder: '/p/wt', order: k('t:bill'), active: 't:bill', layout: null },
      { id: 'a1', parent: 'A', name: 'SSO', color: 1, folder: null, order: k('t:okta', 't:mock'), active: 't:okta', layout: null },
      { id: 'b1', parent: 'B', name: 'Webhooks', color: 2, folder: null, order: k('t:hook'), active: 't:hook', layout: null }
    ],
    members: { auth: 'A', okta: 'a1', mock: 'a1', bill: 'B', hook: 'b1' }
  };
}

/** Every invariant at once: each terminal in exactly one place, the strip holds only the place in front's terminals. */
function invariant() {
  const s = st();
  if (!s.ws?.on) return;
  for (const x of s.terminals) expect(s.ws.list.map((w) => w.id)).toContain(s.ws.members[x.id]);
  for (const key of s.tabOrder) if (key.startsWith('t:')) expect(s.ws.members[key.slice(2)]).toBe(s.ws.active);
  const strips = isSplit(s.split) ? s.split.panes.map((p) => p.tabs) : [s.tabOrder];
  for (const strip of strips) {
    const firstProject = strip.findIndex(isProjectKey);
    if (firstProject >= 0) expect(strip.slice(firstProject).every(isProjectKey)).toBe(true);
  }
  if (isSplit(s.split)) expect(s.tabOrder).toEqual(flatten(s.split));
}

beforeEach(() => {
  stopped.length = 0;
  created.length = 0;
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [],
    openFiles: [], preview: null, pendingAnchor: null, review: null, servicesOpen: false, split: single(), toast: null, dirty: {}, ws: null,
    resumables: [], resumablesKnown: false, space: 'sessions'
  });
  useApp.setState({ settings: { ...st().settings, wsActivities: true } });
});

const start = () => { useApp.setState({ ws: wsActs() }); st().setTerminals(ALL); };

describe('switching places', () => {
  test('an activity comes forward: only its tabs, its front; it stays folded, its workspace remembers it', () => {
    start();
    expect(st().tabOrder).toEqual(k('t:auth'));
    st().switchWorkspace('a1');
    expect(st().ws!.active).toBe('a1');
    expect(st().tabOrder).toEqual(k('t:okta', 't:mock'));
    expect(st().activeKey()).toBe('t:okta');
    expect(isOpen(st().ws!, 'a1')).toBe(false);
    expect(st().ws!.list.find((w) => w.id === 'A')!.place).toBe('a1');
    invariant();
  });
  test('the workspace\'s own tabs come back by its id; goToWorkspace returns where it was left', () => {
    start();
    st().switchWorkspace('a1');
    st().switchWorkspace('A');
    expect(st().tabOrder).toEqual(k('t:auth'));
    st().switchWorkspace('a1');
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill'));
    st().goToWorkspace('A');
    expect(st().ws!.active).toBe('a1');
    expect(st().tabOrder).toEqual(k('t:okta', 't:mock'));
    st().goToWorkspace('B');
    expect(st().ws!.active).toBe('B');
    invariant();
  });
  test('⌥⌘1…9 and Next/Previous count workspaces only and go where each was left', () => {
    start();
    st().switchWorkspace('a1');
    goToWorkspaceAt(1);
    expect(st().ws!.active).toBe('B');
    goToWorkspaceAt(0);
    expect(st().ws!.active).toBe('a1');
    goToWorkspaceAt(2);
    expect(st().ws!.active).toBe('a1');
    stepWorkspace(1);
    expect(st().ws!.active).toBe('B');
    stepWorkspace(1);
    expect(st().ws!.active).toBe('a1');
    invariant();
  });
});

describe('every way to a session goes into its activity', () => {
  test('selecting a terminal of a folded activity of another workspace: it comes forward, its workspace opens, it stays folded', () => {
    start();
    st().select('hook');
    expect(st().ws!.active).toBe('b1');
    expect(st().activeKey()).toBe('t:hook');
    expect(isOpen(st().ws!, 'B')).toBe(true);
    expect(isOpen(st().ws!, 'b1')).toBe(false);
    invariant();
  });
  test('⌘J from the own tabs into a folded activity', async () => {
    const { goToAttention } = await import('./attention-nav');
    useApp.setState({ ws: wsActs(), settings: { ...st().settings, wsJumpFollows: false } });
    st().setTerminals([T.auth, term('okta', 2, 'waiting'), T.mock, T.bill, T.hook]);
    st().select('auth');
    goToAttention();
    expect(st().ws!.active).toBe('a1');
    expect(st().activeKey()).toBe('t:okta');
    expect(isOpen(st().ws!, 'a1')).toBe(false);
  });
  test('activating a tab key of another place brings it forward first', () => {
    start();
    st().activate('t:mock');
    expect(st().ws!.active).toBe('a1');
    expect(st().activeKey()).toBe('t:mock');
    invariant();
  });
});

describe('new things land in the place in front', () => {
  test('a terminal started while an activity is in front joins it, and only it', () => {
    start();
    st().switchWorkspace('a1');
    st().setTerminals([...ALL, term('fresh', 9)]);
    expect(st().ws!.members.fresh).toBe('a1');
    // Next to the tab in front, as anywhere.
    expect(st().tabOrder).toEqual(k('t:okta', 't:fresh', 't:mock'));
    st().switchWorkspace('A');
    expect(st().tabOrder).toEqual(k('t:auth'));
    invariant();
  });
  test('an activity starts things in its workspace\'s folder', async () => {
    start();
    st().switchWorkspace('b1');
    await newTerminalIn();
    await newSessionIn('x');
    expect(created.map((c) => c.cwd)).toEqual(['/p/wt', '/p/wt']);
  });
});

describe('making an activity', () => {
  test('New Activity…: last among its workspace\'s, brought forward empty, its name in edit', () => {
    start();
    const id = st().newWsActivity('A')!;
    expect(st().ws!.list.find((w) => w.id === id)).toMatchObject({ parent: 'A', name: 'New activity' });
    expect(st().ws!.active).toBe(id);
    expect(st().tabOrder).toEqual([]);
    expect(st().wsRenaming).toBe(id);
    expect(isOpen(st().ws!, id)).toBe(false);
    invariant();
  });
  test('from a tab (Move to › New Activity…): the tab goes into it quietly, then it comes forward with it', () => {
    start();
    useApp.setState({ toast: null });
    const id = st().newWsActivity('A', 't:auth')!;
    expect(st().ws!.members.auth).toBe(id);
    expect(st().ws!.active).toBe(id);
    expect(st().tabOrder).toEqual(k('t:auth'));
    expect(st().toast).toBeNull();
    invariant();
  });
  test('refused past twenty, or inside an activity', () => {
    start();
    for (let i = 0; i < 19; i++) expect(st().newWsActivity('A')).not.toBeNull();
    expect(st().newWsActivity('A')).toBeNull();
    expect(st().newWsActivity('a1')).toBeNull();
  });
});

describe('moving rows and tabs between places', () => {
  test('a tab of the strip into a folded activity of another workspace: it leaves, the toast names it, Go goes there', () => {
    start();
    useApp.setState({ toast: null });
    st().moveToWorkspace('t:auth', 'b1');
    expect(st().ws!.members.auth).toBe('b1');
    expect(st().tabOrder).toEqual([]);
    expect(st().toast?.text).toBe('Moved auth to Webhooks');
    st().toast!.action!.run();
    expect(st().ws!.active).toBe('b1');
    expect(st().tabOrder).toEqual(k('t:hook', 't:auth'));
    invariant();
  });
  test('from the activity in front into its workspace\'s own tabs', () => {
    start();
    st().switchWorkspace('a1');
    useApp.setState({ toast: null });
    st().moveToWorkspace('t:mock', 'A');
    expect(st().tabOrder).toEqual(k('t:okta'));
    expect(st().ws!.members.mock).toBe('A');
    expect(st().toast?.text).toBe('Moved mock to Auth');
    invariant();
  });
  test('a row of a sibling activity into the place in front gets its tab here, without a toast', () => {
    start();
    useApp.setState({ toast: null });
    st().moveToWorkspace('t:okta', 'A');
    expect(st().ws!.members.okta).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta'));
    expect(st().toast).toBeNull();
    invariant();
  });
  test('a file tab: the toast names the file', () => {
    start();
    useApp.setState({ openFiles: [{ path: '/p/x.ts', rel: 'src/x.ts' } as never], tabOrder: k('t:auth', 'f:/p/x.ts'), toast: null });
    st().moveToWorkspace('f:/p/x.ts', 'a1');
    expect(st().toast?.text).toBe('Moved x.ts to SSO');
    expect(st().ws!.list.find((w) => w.id === 'a1')!.order).toContain('f:/p/x.ts');
  });
});

describe('moving an activity to another workspace', () => {
  test('the activity in front: the window goes to its workspace\'s own tabs; the toast\'s Go follows it', () => {
    start();
    st().switchWorkspace('a1');
    useApp.setState({ toast: null });
    st().moveWsActivity('a1', 'B');
    expect(st().ws!.active).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth'));
    expect(workspaceOf(st().ws!, 'a1')).toBe('B');
    expect(st().toast?.text).toBe('Moved SSO to Billing');
    st().toast!.action!.run();
    expect(st().ws!.active).toBe('a1');
    expect(st().tabOrder).toEqual(k('t:okta', 't:mock'));
    expect(isOpen(st().ws!, 'B')).toBe(true);
    invariant();
  });
  test('refused for a full workspace: nothing moves, nothing said', () => {
    start();
    for (let i = 0; i < 19; i++) st().newWsActivity('B');
    st().switchWorkspace('A');
    useApp.setState({ toast: null });
    st().moveWsActivity('a1', 'B');
    expect(workspaceOf(st().ws!, 'a1')).toBe('A');
    expect(st().toast).toBeNull();
  });
});

describe('closing an activity', () => {
  test('move, in front: its workspace\'s own tabs come forward with its tabs after them, in its order', async () => {
    start();
    st().switchWorkspace('a1');
    useApp.setState({ openFiles: [{ path: '/p/okta.ts', rel: 'okta.ts' } as never], tabOrder: k('t:okta', 't:mock', 'f:/p/okta.ts') });
    await st().closeWsActivity('a1', 'move');
    expect(st().ws!.list.some((w) => w.id === 'a1')).toBe(false);
    expect(st().ws!.active).toBe('A');
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta', 't:mock', 'f:/p/okta.ts'));
    expect(st().openFiles).toHaveLength(1);
    expect(stopped).toEqual([]);
    invariant();
  });
  test('stop: its terminals stop resumable; its file tabs close unless another place shows them', async () => {
    start();
    useApp.setState({ openFiles: [{ path: '/p/okta.ts', rel: 'okta.ts' } as never] });
    useApp.setState({ ws: { ...st().ws!, list: st().ws!.list.map((w) => (w.id === 'a1' ? { ...w, order: k(...w.order, 'f:/p/okta.ts') } : w)) } });
    await st().closeWsActivity('a1', 'stop');
    expect(stopped).toEqual([['okta', 'mock']]);
    expect(st().ws!.list.some((w) => w.id === 'a1')).toBe(false);
    expect(st().openFiles).toEqual([]);
    expect(st().tabOrder).toEqual(k('t:auth'));
  });
  test('stop with an unsaved file: Cancel leaves everything as it was', async () => {
    start();
    st().switchWorkspace('a1');
    useApp.setState({ openFiles: [{ path: '/p/okta.ts', rel: 'okta.ts' } as never], tabOrder: k('t:okta', 't:mock', 'f:/p/okta.ts'), dirty: { '/p/okta.ts': true } });
    const ask = st().askUnsaved;
    useApp.setState({ askUnsaved: async () => 'cancel' as const });
    try {
      await st().closeWsActivity('a1', 'stop');
    } finally { useApp.setState({ askUnsaved: ask }); }
    expect(stopped).toEqual([]);
    expect(st().ws!.active).toBe('a1');
    expect(st().ws!.list.some((w) => w.id === 'a1')).toBe(true);
  });
});

describe('closing a workspace that has activities', () => {
  test('move: its activities go to the other workspace as activities; its own terminals join its own tabs', async () => {
    start();
    st().switchWorkspace('a1');
    await st().closeWorkspace('A', 'move');
    expect(st().ws!.active).toBe('B');
    expect(st().ws!.list.find((w) => w.id === 'a1')).toMatchObject({ parent: 'B', open: false });
    expect(st().ws!.members).toMatchObject({ auth: 'B', okta: 'a1', mock: 'a1' });
    expect(st().tabOrder).toEqual(k('t:bill', 't:auth'));
    expect(stopped).toEqual([]);
    invariant();
  });
  test('stop: every terminal in it stops, its activities\' too', async () => {
    start();
    await st().closeWorkspace('A', 'stop');
    expect(stopped).toEqual([['auth', 'okta', 'mock']]);
    expect(st().ws!.list.map((w) => w.id)).toEqual(['B', 'b1']);
  });
});

describe('the setting off and on again', () => {
  const setting = (on: boolean) => useApp.setState({ settings: { ...st().settings, wsActivities: on } });
  test('off with an activity in front: its workspace\'s own tabs come forward with every place\'s, front and split kept; nothing stops', () => {
    start();
    st().switchWorkspace('a1');
    st().select('okta');
    st().splitRight();
    st().select('mock');
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:okta'), k('t:mock')]);
    setting(false);
    st().applyWsActivities();
    expect(st().ws!.list.some((w) => w.parent)).toBe(false);
    expect(st().ws!.parked!.list.map((w) => w.id)).toEqual(['a1', 'b1']);
    expect(st().ws!.active).toBe('A');
    expect(st().activeKey()).toBe('t:mock');
    // The other places' tabs join the focused pane.
    expect(st().split.panes.map((p) => p.tabs)).toEqual([k('t:okta'), k('t:mock', 't:auth')]);
    expect(st().ws!.members).toMatchObject({ okta: 'A', mock: 'A', hook: 'B' });
    expect(stopped).toEqual([]);
    invariant();
  });
  test('off with the own tabs in front: the activities\' tabs join the strip after the own ones', () => {
    start();
    setting(false);
    st().applyWsActivities();
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta', 't:mock'));
    expect(st().activeKey()).toBe('t:auth');
    st().switchWorkspace('B');
    expect(st().tabOrder).toEqual(k('t:bill', 't:hook'));
    invariant();
  });
  test('on again: back as they were, but for what moved meanwhile; the place in front stays the workspace', () => {
    start();
    st().switchWorkspace('a1');
    setting(false);
    st().applyWsActivities();
    st().moveToWorkspace('t:okta', 'B');
    st().setTerminals([...ALL, term('later', 9)]);
    setting(true);
    st().applyWsActivities();
    expect(st().ws!.parked).toBeUndefined();
    expect(st().ws!.active).toBe('A');
    expect(st().ws!.members).toMatchObject({ mock: 'a1', okta: 'B', later: 'A', hook: 'b1' });
    expect(st().tabOrder.filter((x) => x.startsWith('t:')).sort()).toEqual(k('t:auth', 't:later'));
    st().switchWorkspace('a1');
    expect(st().tabOrder).toEqual(k('t:mock'));
    invariant();
  });
  test('a window whose save holds activities while the setting is off keeps them aside; the reverse brings them back', () => {
    useApp.setState({ ws: wsActs() });
    setting(false);
    st().setTerminals(ALL);
    st().applyWsActivities();
    expect(st().ws!.parked).toBeDefined();
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta', 't:mock'));
    setting(true);
    st().applyWsActivities();
    expect(st().ws!.list.filter((w) => w.parent).map((w) => w.id)).toEqual(['a1', 'b1']);
    expect(st().tabOrder).toEqual(k('t:auth'));
    invariant();
  });
  test('changed while another space is in front: Sessions takes it when it comes back', () => {
    start();
    st().switchSpace('docker');
    setting(false);
    st().applyWsActivities();
    expect(st().ws!.list.some((w) => w.parent)).toBe(true);
    st().switchSpace('sessions');
    expect(st().ws!.parked).toBeDefined();
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta', 't:mock'));
  });
  test('workspaces off: nothing changes; turning them on finds the activities kept aside', () => {
    useApp.setState({ ws: { ...wsActs(), on: false } });
    setting(false);
    st().setTerminals(ALL);
    st().applyWsActivities();
    expect(st().ws!.list.some((w) => w.parent)).toBe(true);
    st().setWorkspacesOn(true);
    expect(st().ws!.parked).toBeDefined();
    expect(st().tabOrder).toEqual(k('t:auth', 't:okta', 't:mock'));
    invariant();
  });
});

describe('Resume inside an activity', () => {
  test('its Resume head\'s Resume all acts on that activity\'s sessions, whatever place is in front', async () => {
    const resumed: string[] = [];
    const api = (g.window as { atelier: { terminals: Record<string, unknown> } }).atelier.terminals;
    api.resume = async (id: string) => { resumed.push(id); return { ...term(`${id}2`, 60), session: { state: 'idle' } as unknown as TerminalInfo['session'] }; };
    const res = (id: string) => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: id, endedAt: 1 });
    useApp.setState({ ws: { ...wsActs(), members: { ...wsActs().members, oldA: 'A', old1: 'a1', old2: 'a1' } }, resumables: [res('oldA'), res('old1'), res('old2')], resumablesKnown: true });
    st().setTerminals(ALL);
    await st().resumeAll('all', 'a1');
    expect(resumed.sort()).toEqual(['old1', 'old2']);
  });
});

describe('the Go menu', () => {
  test('lists workspaces only; its check marks the workspace in front whichever of its places is', () => {
    expect(workspacesMenu({ ...wsActs(), active: 'b1' })).toEqual({ names: ['Auth', 'Billing'], active: 1 });
    expect(workspacesMenu(wsActs())).toEqual({ names: ['Auth', 'Billing'], active: 0 });
    expect(workspaceOf(wsActs(), 'b1')).toBe('B');
  });
});
