import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { single } from '../split';
import type { WorkspacesState } from '../workspaces';
import { wsActivityCloseText } from '../workspace-view';
import { WsActivityCloseHost } from './WsActivityCloseHost';
import { WorkspaceCloseHost } from './WorkspaceCloseHost';
import { WorkspaceEmpty } from '../components/WorkspaceEmpty';

// Closing an activity asks what to do with what is inside; an activity with nothing open shows its own empty state.

const term = (id: string, state: string | null, unread = false): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: state ? 'claude' : 'zsh', createdAt: 1,
  session: state ? ({ sessionId: id, state, waitingFor: state === 'waiting' ? 'permission' : undefined, unread, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
const res = (id: string): Resumable => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: id, endedAt: 1 });
/** A (Auth) with SSO (a1: okta-callback waiting, okta-config done, okta mock running, okta.ts) and Reset (a2: empty), then B. */
const WS = (): WorkspacesState => ({
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:tok'], active: 't:tok', layout: null },
    { id: 'a1', parent: 'A', name: 'SSO with Okta', color: 1, folder: null, order: ['t:okta-callback', 't:okta-config', 't:okta mock', 'f:/p/okta.ts'], active: null, layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:bill'], active: 't:bill', layout: null },
    { id: 'a2', parent: 'A', name: 'Reset', color: 1, folder: null, order: [], active: null, layout: null }
  ],
  members: { tok: 'A', 'okta-callback': 'a1', 'okta-config': 'a1', 'okta mock': 'a1', bill: 'B' }
});
const LIST = [term('tok', 'idle'), term('okta-callback', 'waiting'), term('okta-config', 'done', true), term('okta mock', null), term('bill', 'idle')];
const render = (c: () => unknown) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(c as never));
};

// The confirm anchors itself with CSS.escape, which node lacks.
(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, ws: WS(), terminals: LIST, resumables: [], pins: [], split: single(),
    openFiles: [{ path: '/p/okta.ts', rel: 'okta.ts' } as never], revFiles: [], wsActCloseAsk: null, wsCloseAsk: null, tabOrder: ['t:tok'], selectedId: 'tok'
  });
  useApp.setState({ settings: { ...useApp.getState().settings, wsActivities: true } });
});

test('the sentence says who is inside and what each does, then its file tabs', () => {
  expect(wsActivityCloseText(WS(), 'a1', LIST, [], '/p', ['/p/okta.ts'], [])).toBe(
    'okta-callback is waiting for you, okta-config is done and okta mock is running. It has a file tab.'
  );
  expect(wsActivityCloseText(WS(), 'a1', [term('okta mock', null)], [res('okta-callback')], '/p', [], [])).toBe(
    'okta mock is running and okta-callback waits to be resumed.'
  );
});

test('Close Activity…: its question, Move (the default, Enter) back to its workspace, Stop, Cancel', () => {
  useApp.setState({ wsActCloseAsk: 'a1' });
  const out = render(WsActivityCloseHost);
  expect(out).toContain('Close “SSO with Okta”?');
  expect(out).toContain('okta-callback is waiting for you');
  expect(out).toContain('Moving them puts their tabs back in Auth. Stopping them closes its terminals and file tabs; its sessions wait under Resume in Auth.');
  expect(out).toMatch(/class="btn-primary[^"]*"[^>]*data-autofocus[^>]*>Move them to Auth/);
  expect(out).toContain('Stop them, resume later');
  expect(out).toContain('Cancel');
  useApp.setState({ wsActCloseAsk: null });
  expect(render(WsActivityCloseHost)).toBe('');
});

test('Close Workspace… moves into a workspace, never into an activity', () => {
  useApp.setState({ wsCloseAsk: 'B' });
  const out = render(WorkspaceCloseHost);
  expect(out).toContain('Move them to Auth');
  expect(out).not.toContain('Move them to SSO');
});

test('Close Workspace… on a workspace with activities counts what they hold and says where they go', () => {
  useApp.setState({ wsCloseAsk: 'A' });
  const out = render(WorkspaceCloseHost);
  expect(out).toContain('3 sessions and 1 terminal are in it.');
  expect(out).toContain('Moving them takes its 2 activities to Billing as they are.');
});

test('an activity with nothing open: its glyph, its name, what to do, how to fill it', () => {
  useApp.setState({ ws: { ...WS(), active: 'a2' }, tabOrder: [], selectedId: null });
  const out = render(() => createElement(WorkspaceEmpty, { onSession: () => {}, onTerminal: () => {} }));
  expect(out).toContain('<h2>Reset</h2>');
  expect(out).toContain('Nothing open in this activity.');
  expect(out).toContain('Drag sessions, terminals or tabs onto it in the sidebar, or right-click one › Move to.');
  expect(out).toContain('ws-empty-glyph');
  expect(out).not.toContain('Resume ');
});

test('an activity whose terminals run with their tabs closed says so; one with a session to resume offers it', () => {
  useApp.setState({ ws: { ...WS(), active: 'a1' }, tabOrder: [], selectedId: null });
  expect(render(() => createElement(WorkspaceEmpty, { onSession: () => {}, onTerminal: () => {} }))).toContain('Its sessions and terminals keep running');
  useApp.setState({ ws: { ...WS(), active: 'a2', members: { ...WS().members, old: 'a2' } }, resumables: [res('old')] });
  expect(render(() => createElement(WorkspaceEmpty, { onSession: () => {}, onTerminal: () => {} }))).toContain('Resume old');
});

test('a workspace\'s own tabs empty: today\'s empty state', () => {
  useApp.setState({ ws: { ...WS(), list: WS().list.filter((w) => !w.parent), members: { bill: 'B' }, active: 'A' }, terminals: [term('bill', 'idle')], tabOrder: [], selectedId: null });
  const out = render(() => createElement(WorkspaceEmpty, { onSession: () => {}, onTerminal: () => {} }));
  expect(out).toContain('Nothing running in Auth');
  expect(out).not.toContain('ws-empty-glyph');
});
