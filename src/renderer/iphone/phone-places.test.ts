import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import type { RemotePlaceDone, RemotePlaceRequest } from '@shared/remote';
import type { Settings } from '@shared/settings';
import { useApp } from '../store';
import { single } from '../split';
import type { TabKey } from '../tabs-model';
import { memberOf, type Workspace, type WorkspacesState } from '../workspaces';
import { applyPlaceOp, installPhonePlaces, nextWorkspaceName } from './phone-places';

// A paired phone's changes to the workspaces and activities, applied in the project's main window as its own menus
// and drags would, quietly: nothing comes to the front, no name opens for editing, no toast.

const g = globalThis as { window?: unknown; localStorage?: unknown };
let had: unknown;
let hadStorage: unknown;
/** What Settings › set was asked (a phone's change never should). */
const settingsAsked: Partial<Settings>[] = [];
const done: RemotePlaceDone[] = [];
let held: RemotePlaceRequest[] = [];
const listeners = new Set<(r: RemotePlaceRequest) => void>();
let readyAsked = 0;
/** The terminals main was asked to stop; how often the unsaved-files question was asked. */
const stopped: string[] = [];
let unsavedAsked = 0;
beforeAll(() => {
  had = g.window;
  hadStorage = g.localStorage;
  const saved = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
  g.window = {
    addEventListener: () => {},
    atelier: {
      settings: {
        set: async (p: Partial<Settings>) => {
          settingsAsked.push(p);
          setTimeout(() => useApp.setState({ settings: { ...useApp.getState().settings, ...p } }), 5);
          return { ...useApp.getState().settings, ...p };
        }
      },
      remote: {
        placesReady: async () => { readyAsked++; const h = held; held = []; return h; },
        placeDone: async (d: RemotePlaceDone) => { done.push(d); }
      },
      on: { remotePlaces: (cb: (r: RemotePlaceRequest) => void) => { listeners.add(cb); return () => listeners.delete(cb); } },
      terminals: { stop: async (ids: string[]) => { stopped.push(...ids); } }
    }
  };
});
afterAll(() => { g.window = had; g.localStorage = hadStorage; });

function term(id: string, createdAt: number): TerminalInfo {
  return { id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null };
}
const resumable = (id: string, projectRoot = '/p'): Resumable => ({ id, projectRoot, cwd: projectRoot, title: id, color: '#B794F6', sessionId: `s-${id}`, endedAt: 1 });
const st = () => useApp.getState();
const k = (...keys: string[]) => keys as TabKey[];
const w = (o: Partial<Workspace> & { id: string }): Workspace => ({ name: o.id, color: 1, folder: null, order: [], active: null, layout: null, ...o });

/** Main (w1: auth, okta in its activity SSO a1) and Billing (w2: bill). Main's own tabs in front. */
function twoWorkspaces(): WorkspacesState {
  return {
    on: true, active: 'w1',
    list: [w({ id: 'w1', name: 'Main', order: k('t:auth'), active: 't:auth' }), w({ id: 'w2', name: 'Billing', color: 2, order: k('t:bill'), active: 't:bill' }), w({ id: 'a1', parent: 'w1', name: 'SSO', color: 3, order: k('t:okta'), active: 't:okta' })],
    members: { auth: 'w1', okta: 'a1', bill: 'w2' }
  };
}

beforeEach(() => {
  settingsAsked.length = 0;
  done.length = 0;
  held = [];
  readyAsked = 0;
  stopped.length = 0;
  unsavedAsked = 0;
  listeners.clear();
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, terminals: [], selectedId: null, activeTab: 'term', tabOrder: [], hidden: [], pins: [],
    openFiles: [], preview: null, pendingAnchor: null, review: null, servicesOpen: false, split: single(), toast: null, dirty: {}, ws: null,
    resumables: [], resumablesKnown: false, space: 'sessions', wsRenaming: null, closing: {}, wsCloseAsk: null, wsActCloseAsk: null,
    askUnsaved: async () => { unsavedAsked++; return 'cancel'; }
  });
  useApp.setState({ settings: { ...st().settings, wsActivities: false, workspacesEverywhere: false, remoteAccess: true } });
});

describe('the default name', () => {
  test('"Workspace N": N the count it makes, past the names already taken; activities don\'t count', () => {
    expect(nextWorkspaceName(null)).toBe('Workspace 1');
    expect(nextWorkspaceName({ list: [w({ id: 'w1', name: 'Workspace 1' })] })).toBe('Workspace 2');
    expect(nextWorkspaceName({ list: [w({ id: 'w1', name: 'Main' }), w({ id: 'w2', name: 'Billing' }), w({ id: 'a', parent: 'w1', name: 'x' })] })).toBe('Workspace 3');
    expect(nextWorkspaceName({ list: [w({ id: 'w1', name: 'Workspace 2' }), w({ id: 'w2', name: 'workspace 3' })] })).toBe('Workspace 4');
  });
});

const WORKSPACES_OFF = 'Workspaces are off in this project. Turn them on in Atelier on this computer.';
const ACTIVITIES_OFF = 'Activities are off. Turn them on in Atelier on this computer.';

describe('workspace', () => {
  test('workspaces off in this project: refused in words, nothing turns on, Settings never asked', async () => {
    st().setTerminals([term('auth', 1), term('bill', 2)]);
    expect(await applyPlaceOp({ kind: 'workspace' })).toEqual({ ok: false, code: 'invalid', message: WORKSPACES_OFF });
    useApp.setState({ ws: { ...twoWorkspaces(), on: false } });
    expect(await applyPlaceOp({ kind: 'workspace', name: 'Release' })).toEqual({ ok: false, code: 'invalid', message: WORKSPACES_OFF });
    expect(st().ws!.on).toBe(false);
    expect(st().ws!.list.map((x) => x.name)).toEqual(['Main', 'Billing', 'SSO']);
    expect(settingsAsked).toEqual([]);
  });

  test('on only through Workspaces in every project, turned off since (the window not yet applied it): refused, nothing made', async () => {
    // As a window opened for the phone restores them, before it applies the setting and they go.
    useApp.setState({ ws: { ...twoWorkspaces(), forced: true }, settings: { ...st().settings, workspacesEverywhere: false, wsActivities: true } });
    st().setTerminals([term('auth', 1), term('bill', 2)]);
    expect(await applyPlaceOp({ kind: 'workspace', name: 'Release' })).toEqual({ ok: false, code: 'invalid', message: WORKSPACES_OFF });
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'w1' })).toEqual({ ok: false, code: 'invalid', message: WORKSPACES_OFF });
    expect(st().ws!.list.map((x) => x.name)).toEqual(['Main', 'Billing', 'SSO']);
  });

  test('on in every project, before the window applied it: on as that setting does (everything in Workspace 1), then a new empty "Workspace 2", left behind the one in front', async () => {
    useApp.setState({ settings: { ...st().settings, workspacesEverywhere: true } });
    st().setTerminals([term('auth', 1), term('bill', 2)]);
    const r = await applyPlaceOp({ kind: 'workspace' });
    expect(r).toEqual({ ok: true, place: expect.any(String) });
    const ws = st().ws!;
    expect(ws.on).toBe(true);
    // Set by the setting, as Workspaces in every project does: it goes when that setting does.
    expect(ws.forced).toBe(true);
    expect(ws.list.map((x) => x.name)).toEqual(['Workspace 1', 'Workspace 2']);
    const [first, made] = ws.list;
    expect(made!.id).toBe(r.ok && r.place);
    expect(ws.active).toBe(first!.id);
    expect(memberOf(ws, 'auth')).toBe(first!.id);
    expect(memberOf(ws, 'bill')).toBe(first!.id);
    expect(st().wsRenaming).toBeNull();
    expect(st().toast).toBeNull();
  });

  test('on in every project while the window showed another space (the setting waited for Sessions): Sessions comes forward with them on, then the new one', async () => {
    st().setTerminals([term('auth', 1)]);
    st().switchSpace('docker');
    useApp.setState({ settings: { ...st().settings, workspacesEverywhere: true } });
    st().applyWorkspacesEverywhere();
    expect(st().ws?.on ?? false).toBe(false);
    const r = await applyPlaceOp({ kind: 'workspace', name: 'Release' });
    expect(r).toEqual({ ok: true, place: expect.any(String) });
    expect(st().space).toBe('sessions');
    expect(st().ws!.on).toBe(true);
    expect(st().ws!.list.map((x) => x.name)).toEqual(['Workspace 1', 'Release']);
  });

  test('named; on in every project, workspaces kept from when they were on come back first', async () => {
    useApp.setState({ ws: { ...twoWorkspaces(), on: false }, settings: { ...st().settings, workspacesEverywhere: true } });
    st().setTerminals([term('auth', 1), term('okta', 2), term('bill', 3)]);
    const r = await applyPlaceOp({ kind: 'workspace', name: '  Release  ' });
    expect(r.ok).toBe(true);
    expect(st().ws!.list.filter((x) => !x.parent).map((x) => x.name)).toEqual(['Main', 'Billing', 'Release']);
    expect(st().ws!.active).toBe('w1');
  });

  test('a project at its 20 workspaces: refused, nothing made', async () => {
    useApp.setState({ ws: { on: true, active: 'w0', list: Array.from({ length: 20 }, (_, i) => w({ id: `w${i}` })), members: {} } });
    expect(await applyPlaceOp({ kind: 'workspace' })).toEqual({ ok: false, code: 'invalid', message: 'This project has 20 workspaces already.' });
    expect(st().ws!.list).toHaveLength(20);
  });
});

describe('activity', () => {
  test('activities off: refused in words, Settings never asked, the activities kept aside stay aside', async () => {
    useApp.setState({ ws: twoWorkspaces() });
    st().setTerminals([term('auth', 1), term('okta', 2), term('bill', 3)]);
    // Off: the window keeps SSO aside, as the setting says.
    st().applyWsActivities();
    expect(st().ws!.list.some((x) => x.parent)).toBe(false);
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'w2' })).toEqual({ ok: false, code: 'invalid', message: ACTIVITIES_OFF });
    expect(settingsAsked).toEqual([]);
    expect(st().settings.wsActivities).toBe(false);
    expect(st().ws!.list.some((x) => x.parent)).toBe(false);
  });

  test('activities on: "New activity" in that workspace, folded, not in front', async () => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true } });
    st().setTerminals([term('auth', 1), term('okta', 2), term('bill', 3)]);
    const r = await applyPlaceOp({ kind: 'activity', workspace: 'w2' });
    expect(r).toEqual({ ok: true, place: expect.any(String) });
    const ws = st().ws!;
    const made = ws.list.find((x) => r.ok && x.id === r.place)!;
    expect(made).toMatchObject({ name: 'New activity', parent: 'w2' });
    expect(memberOf(ws, 'okta')).toBe('a1');
    expect(ws.active).toBe('w1');
    expect(st().wsRenaming).toBeNull();
  });

  test('named, activities on: nothing asked of Settings', async () => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true } });
    const r = await applyPlaceOp({ kind: 'activity', workspace: 'w1', name: 'Release' });
    expect(r.ok).toBe(true);
    expect(st().ws!.list.filter((x) => x.parent === 'w1').map((x) => x.name)).toEqual(['SSO', 'Release']);
    expect(settingsAsked).toEqual([]);
  });

  test('refused: an activity as the workspace, one that is gone, workspaces off, a full workspace', async () => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true } });
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'a1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'gone' })).toMatchObject({ ok: false, code: 'not-found' });
    useApp.setState({ ws: { ...twoWorkspaces(), list: [...twoWorkspaces().list, ...Array.from({ length: 20 }, (_, i) => w({ id: `x${i}`, parent: 'w2' }))] } });
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'w2' })).toEqual({ ok: false, code: 'invalid', message: 'This workspace has 20 activities already.' });
    useApp.setState({ ws: { ...twoWorkspaces(), on: false } });
    expect(await applyPlaceOp({ kind: 'activity', workspace: 'w1' })).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('rename', () => {
  test('a workspace or an activity; whole characters kept at the 60 limit; a place that is gone is not found', async () => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true } });
    expect(await applyPlaceOp({ kind: 'rename', place: 'w2', name: 'Payments' })).toEqual({ ok: true });
    expect(await applyPlaceOp({ kind: 'rename', place: 'a1', name: 'Okta' })).toEqual({ ok: true });
    expect(st().ws!.list.map((x) => x.name)).toEqual(['Main', 'Payments', 'Okta']);
    // 31 emoji are 62 UTF-16 units: 30 of them fit whole.
    expect(await applyPlaceOp({ kind: 'rename', place: 'w1', name: '🚀'.repeat(31) })).toEqual({ ok: true });
    expect(st().ws!.list[0]!.name).toBe('🚀'.repeat(30));
    expect(await applyPlaceOp({ kind: 'rename', place: 'gone', name: 'X' })).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('move', () => {
  beforeEach(() => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true }, tabOrder: k('t:auth'), activeTab: 'term', selectedId: 'auth' });
    st().setTerminals([term('auth', 1), term('okta', 2), term('bill', 3)]);
  });

  test('a terminal of the place in front into an activity: its row goes there, its tab leaves the strip, no toast', async () => {
    expect(await applyPlaceOp({ kind: 'move', id: 'auth', place: 'a1' })).toEqual({ ok: true });
    expect(memberOf(st().ws!, 'auth')).toBe('a1');
    expect(st().tabOrder).not.toContain('t:auth');
    expect(st().toast).toBeNull();
  });

  test('a terminal of another place into the one in front; into where it is already: fine, nothing changes', async () => {
    expect(await applyPlaceOp({ kind: 'move', id: 'bill', place: 'w1' })).toEqual({ ok: true });
    expect(memberOf(st().ws!, 'bill')).toBe('w1');
    const before = st().ws;
    expect(await applyPlaceOp({ kind: 'move', id: 'okta', place: 'a1' })).toEqual({ ok: true });
    expect(st().ws).toBe(before);
  });

  test('a session to resume: its place changes (the Resume of that place lists it)', async () => {
    useApp.setState({ resumables: [resumable('r1'), resumable('far', '/q')], resumablesKnown: true });
    expect(await applyPlaceOp({ kind: 'move', id: 'r1', place: 'w2' })).toEqual({ ok: true });
    expect(memberOf(st().ws!, 'r1')).toBe('w2');
    expect(await applyPlaceOp({ kind: 'move', id: 'far', place: 'w2' })).toMatchObject({ ok: false, code: 'not-found' });
  });

  test('an unknown row or place, or workspaces off: not found', async () => {
    expect(await applyPlaceOp({ kind: 'move', id: 'nope', place: 'w1' })).toMatchObject({ ok: false, code: 'not-found' });
    expect(await applyPlaceOp({ kind: 'move', id: 'auth', place: 'gone' })).toMatchObject({ ok: false, code: 'not-found' });
    useApp.setState({ ws: { ...st().ws!, on: false } });
    expect(await applyPlaceOp({ kind: 'move', id: 'auth', place: 'w2' })).toMatchObject({ ok: false, code: 'not-found' });
  });
});

describe('close', () => {
  beforeEach(() => {
    useApp.setState({ ws: twoWorkspaces(), settings: { ...st().settings, wsActivities: true }, tabOrder: k('t:auth'), activeTab: 'term', selectedId: 'auth' });
    st().setTerminals([term('auth', 1), term('okta', 2), term('bill', 3)]);
  });

  test('a workspace: what is in it joins the workspace above, nothing stops, no question, no toast', async () => {
    expect(await applyPlaceOp({ kind: 'close', place: 'w2', how: 'move' })).toEqual({ ok: true });
    expect(st().ws!.list.map((x) => x.id)).toEqual(['w1', 'a1']);
    expect(memberOf(st().ws!, 'bill')).toBe('w1');
    expect(stopped).toEqual([]);
    expect([st().wsCloseAsk, st().toast]).toEqual([null, null]);
  });

  test('the first workspace goes to the one below, its activities with it; an activity moves into its workspace', async () => {
    expect(await applyPlaceOp({ kind: 'close', place: 'a1', how: 'move' })).toEqual({ ok: true });
    expect(memberOf(st().ws!, 'okta')).toBe('w1');
    expect(await applyPlaceOp({ kind: 'close', place: 'w1', how: 'move' })).toEqual({ ok: true });
    expect(st().ws!.list.map((x) => x.id)).toEqual(['w2']);
    expect(memberOf(st().ws!, 'auth')).toBe('w2');
    expect(stopped).toEqual([]);
  });

  test('stop: its terminals stop (sessions come back under Resume) and the place goes', async () => {
    expect(await applyPlaceOp({ kind: 'close', place: 'a1', how: 'stop' })).toEqual({ ok: true });
    expect(stopped).toEqual(['okta']);
    expect(await applyPlaceOp({ kind: 'close', place: 'w2', how: 'stop' })).toEqual({ ok: true });
    expect(stopped).toEqual(['okta', 'bill']);
    expect(st().ws!.list.map((x) => x.id)).toEqual(['w1']);
  });

  test('stop, when this atelierd can\'t keep stopped sessions under Resume: refused in words, nothing stops; move still goes', async () => {
    useApp.setState({ daemon: { ...st().daemon, closeStopAvailable: false } });
    const before = st().ws;
    expect(await applyPlaceOp({ kind: 'close', place: 'a1', how: 'stop' })).toEqual({ ok: false, code: 'invalid', message: 'This computer can\'t keep stopped sessions under Resume: move them instead, or stop them on this computer.' });
    expect([stopped, st().ws]).toEqual([[], before]);
    expect(await applyPlaceOp({ kind: 'close', place: 'a1', how: 'move' })).toEqual({ ok: true });
  });

  test('the last workspace stays; a place that is gone, or workspaces off, is not found', async () => {
    expect(await applyPlaceOp({ kind: 'close', place: 'w2', how: 'move' })).toEqual({ ok: true });
    expect(await applyPlaceOp({ kind: 'close', place: 'w1', how: 'stop' })).toEqual({ ok: false, code: 'invalid', message: 'A project\'s last workspace stays.' });
    expect(stopped).toEqual([]);
    expect(await applyPlaceOp({ kind: 'close', place: 'gone', how: 'move' })).toMatchObject({ ok: false, code: 'not-found' });
    useApp.setState({ ws: { ...st().ws!, on: false } });
    expect(await applyPlaceOp({ kind: 'close', place: 'a1', how: 'move' })).toMatchObject({ ok: false, code: 'not-found' });
  });

  test('an unsaved file the close would take: refused in words, nothing asked on this computer, nothing changes', async () => {
    const ws = twoWorkspaces();
    useApp.setState({
      ws: { ...ws, list: ws.list.map((x) => (x.id === 'w2' ? { ...x, order: k('t:bill', 'f:/p/notes.md') } : x)) },
      openFiles: [{ path: '/p/notes.md' } as never], dirty: { '/p/notes.md': true }
    });
    const before = st().ws;
    expect(await applyPlaceOp({ kind: 'close', place: 'w2', how: 'move' })).toEqual({ ok: false, code: 'invalid', message: 'It has unsaved files: save or close them on this computer first.' });
    expect(unsavedAsked).toBe(0);
    expect(st().ws).toBe(before);
    // Saved: it goes, its file tab with it.
    useApp.setState({ dirty: {} });
    expect(await applyPlaceOp({ kind: 'close', place: 'w2', how: 'move' })).toEqual({ ok: true });
  });
});

describe('the window\'s plumbing', () => {
  const ready = () => useApp.setState({ settingsLoaded: true, tabsRestored: true, daemon: { ...st().daemon, listed: true } });

  test('asks for the changes that waited once it has its settings, saved tabs and atelierd\'s list; applies them in order and answers each with its layout', async () => {
    // A window just opened for them, in a project that has workspaces through Workspaces in every project.
    useApp.setState({ settingsLoaded: false, tabsRestored: false, daemon: { ...st().daemon, listed: false }, settings: { ...st().settings, workspacesEverywhere: true } });
    held = [{ id: 1, op: { kind: 'workspace' } }, { id: 2, op: { kind: 'workspace', name: 'Second' } }];
    const off = installPhonePlaces();
    try {
      await Promise.resolve();
      expect(readyAsked).toBe(0);
      ready();
      await vi.waitFor(() => expect(done).toHaveLength(2));
      expect(readyAsked).toBe(1);
      expect(done.map((d) => d.id)).toEqual([1, 2]);
      expect(done[0]!.result).toMatchObject({ ok: true });
      expect(done[1]!.layout.workspaces!.places.map((p) => p.name)).toEqual(['Workspace 1', 'Workspace 2', 'Second']);
      // Later ones come as events.
      for (const cb of listeners) cb({ id: 3, op: { kind: 'rename', place: 'nope', name: 'X' } });
      await vi.waitFor(() => expect(done).toHaveLength(3));
      expect(done[2]).toMatchObject({ id: 3, result: { ok: false, code: 'not-found' } });
    } finally { off(); }
  });

  test('a pop-out, or access off: never asks; access turned on later: asks then', async () => {
    ready();
    useApp.setState({ popout: { key: 't:auth' } as never });
    const offPop = installPhonePlaces();
    await Promise.resolve();
    offPop();
    useApp.setState({ popout: null, settings: { ...st().settings, remoteAccess: false } });
    const off = installPhonePlaces();
    try {
      await Promise.resolve();
      expect(readyAsked).toBe(0);
      useApp.setState({ settings: { ...st().settings, remoteAccess: true } });
      await vi.waitFor(() => expect(readyAsked).toBe(1));
    } finally { off(); }
  });
});
