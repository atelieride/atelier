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

describe('the Go menu', () => {
  test('lists workspaces only; its check marks the workspace in front whichever of its places is', () => {
    expect(workspacesMenu({ ...wsActs(), active: 'b1' })).toEqual({ names: ['Auth', 'Billing'], active: 1 });
    expect(workspacesMenu(wsActs())).toEqual({ names: ['Auth', 'Billing'], active: 0 });
    expect(workspaceOf(wsActs(), 'b1')).toBe('B');
  });
});
