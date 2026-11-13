import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { single } from '../split';
import type { WorkspacesState } from '../workspaces';
import { Sidebar } from './Sidebar';

// Activities in the sidebar: inside an open workspace, before its own rows, at the same indent;
// a folded current activity is the selected box; an open one sits on a band.

const term = (id: string, state: string | null): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: state ? 'claude' : 'zsh', createdAt: 1,
  session: state ? ({ sessionId: id, state, waitingFor: state === 'waiting' ? 'permission' : undefined, title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
/** Auth: own tok; SSO (okta waiting, mock terminal); Reset (empty). Billing (folded): bill. */
const WS = (over: Partial<WorkspacesState> = {}, open: Record<string, boolean> = {}): WorkspacesState => ({
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:tok'], active: 't:tok', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:bill'], active: 't:bill', layout: null },
    { id: 'a1', parent: 'A', name: 'SSO with Okta', color: 1, folder: null, order: ['t:okta', 't:mock'], active: 't:okta', layout: null, ...(open.a1 ? { open: true } : {}) },
    { id: 'a2', parent: 'A', name: 'Password reset', color: 1, folder: null, order: [], active: null, layout: null, ...(open.a2 ? { open: true } : {}) }
  ],
  members: { tok: 'A', okta: 'a1', mock: 'a1', bill: 'B' },
  ...over
});
const html = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(Sidebar));
};
const count = (s: string, needle: string) => s.split(needle).length - 1;
/** The markup of activity `name`'s group. */
const group = (out: string, name: string) => {
  const i = out.indexOf(`aria-label="${name}"`);
  const start = out.lastIndexOf('<section', i);
  return out.slice(start, out.indexOf('</section>', i) + 10);
};

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, activity: 'sessions', tabOrder: ['t:tok'], selectedId: 'tok',
    activeTab: 'term', hidden: [], split: single(), ws: WS(), resumables: [], pins: [], bulkResume: null, groupByState: false,
    terminals: [term('tok', 'idle'), term('okta', 'waiting'), term('mock', null), term('bill', 'idle')], wsRenaming: null
  });
  useApp.setState({ settings: { ...useApp.getState().settings, wsActivities: true } });
});

test('inside an open workspace its activities come first, in order, then its own rows; the head counts workspaces', () => {
  const out = html();
  expect(count(out, 'class="wsa-group')).toBe(2);
  expect(out.indexOf('SSO with Okta')).toBeLessThan(out.indexOf('Password reset'));
  expect(out.indexOf('Password reset')).toBeLessThan(out.indexOf('class="ws-own'));
  expect(out.indexOf('class="ws-own')).toBeLessThan(out.indexOf('>tok<'));
  // The Workspaces head counts 2, not 4.
  expect(out).toMatch(/Workspaces<\/span><span class="count mono">2</);
  // Never a class of the activity bar's.
  expect(out).not.toMatch(/class="act/);
});

test('a folded activity: no rows; its dot is the most urgent state inside, its tooltip says what is inside', () => {
  const g = group(html(), 'SSO with Okta');
  expect(g).not.toContain('>okta<');
  expect(g).toContain('class="ws-dot is-waiting"');
  expect(g).toContain('data-tip="SSO with Okta · 1 needs you · 1 terminal"');
  expect(g).toMatch(/aria-expanded="false"/);
  expect(g).toContain('aria-label="Show the tabs of SSO with Okta"');
});

test('the current activity, folded: its head is the selected box and its workspace\'s name steps down', () => {
  useApp.setState({ ws: WS({ active: 'a1' }), tabOrder: ['t:okta', 't:mock'], selectedId: 'okta' });
  const out = html();
  const g = group(out, 'SSO with Okta');
  expect(g).toContain('class="wsa-group is-current"');
  expect(g).toMatch(/class="wsa-head is-selected"/);
  expect(g).toContain('aria-current="location"');
  expect(g).toContain('aria-label="SSO with Okta"');
  expect(out).toMatch(/class="ws-group is-active is-open in-act"/);
  expect(out).toContain('aria-label="Show the tabs of Auth outside its activities"');
});

test('the current activity, open: on its band, its rows inside; the row in front is the selected one, not its head', () => {
  useApp.setState({ ws: WS({ active: 'a1' }, { a1: true }), tabOrder: ['t:okta', 't:mock'], selectedId: 'okta', activeTab: 'term' });
  const g = group(html(), 'SSO with Okta');
  expect(g).toContain('class="wsa-group is-open is-current"');
  expect(g).toMatch(/class="wsa-head"/);
  expect(count(g, 'is-selected')).toBe(1);
  expect(g).toMatch(/class="session-row[^"]*is-selected[^"]*"[^>]*>(?:(?!<\/button>).)*okta/s);
  expect(g).toContain('>okta<');
  expect(g).toContain('>mock<');
  expect(g).not.toContain('ws-dot');
});

test('an open activity with nothing in it says how to fill it', () => {
  useApp.setState({ ws: WS({}, { a2: true }) });
  expect(group(html(), 'Password reset')).toContain('Empty. Drag sessions here, or + starts one.');
});

test('a workspace with activities and no own rows says nothing; with neither, today\'s empty text', () => {
  useApp.setState({ ws: WS({ members: { okta: 'a1', mock: 'a1', bill: 'B' } }), terminals: [term('okta', 'waiting'), term('mock', null), term('bill', 'idle')] });
  expect(html()).not.toContain('Empty. + starts a session here.');
  useApp.setState({ ws: { ...WS(), list: WS().list.filter((w) => !w.parent), members: { bill: 'B' } }, terminals: [term('bill', 'idle')] });
  expect(html()).toContain('Empty. + starts a session here.');
});

test('drop targets: every activity but the one in front; the own rows while an activity of the workspace is in front', () => {
  let out = html();
  expect(count(out, 'data-ws-drop="a1"')).toBe(1);
  expect(count(out, 'data-ws-drop="a2"')).toBe(1);
  expect(out).not.toContain('data-ws-drop="A"');
  useApp.setState({ ws: WS({ active: 'a1' }), tabOrder: ['t:okta', 't:mock'], selectedId: 'okta' });
  out = html();
  expect(out).not.toContain('data-ws-drop="a1"');
  expect(count(out, 'data-ws-drop="A"')).toBe(2);
});

test('Dismiss All… asked from the workspace\'s own rows shows its question there only, not in an activity\'s Resume head', () => {
  const res = (id: string) => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: id, endedAt: 1 });
  useApp.setState({
    ws: WS({ active: 'a1', members: { tok: 'A', okta: 'a1', mock: 'a1', bill: 'B', o1: 'A', o2: 'A', s1: 'a1', s2: 'a1' } }, { a1: true }),
    resumables: [res('o1'), res('o2'), res('s1'), res('s2')], tabOrder: ['t:okta', 't:mock'], selectedId: 'okta',
    dismissAllAsk: true, dismissAllPlace: 'A'
  });
  const out = html();
  expect(count(out, 'resume-head is-confirming')).toBe(1);
  const own = out.slice(out.indexOf('class="ws-own'));
  expect(own).toContain('resume-head is-confirming');
  useApp.setState({ dismissAllAsk: false, dismissAllPlace: null });
});

test('with the setting off the sidebar is today\'s: no activity heads', () => {
  useApp.setState({ settings: { ...useApp.getState().settings, wsActivities: false }, ws: { ...WS(), list: WS().list.filter((w) => !w.parent), members: { tok: 'A', bill: 'B' } } });
  const out = html();
  expect(out).not.toContain('wsa-');
  expect(out).not.toContain('ws-own');
});
