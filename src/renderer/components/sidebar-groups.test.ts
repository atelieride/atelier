import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { single } from '../split';
import type { WorkspacesState } from '../workspaces';
import { Sidebar } from './Sidebar';

// The sidebar's workspaces as groups: quiet heads, rows indented, no Sessions or
// Terminals labels inside, the shared bits once.

const term = (id: string, session: boolean): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: session ? 'claude' : 'zsh', createdAt: 1,
  session: session ? ({ sessionId: id, state: 'idle', title: null, activity: null, contextPct: null, unread: false, updatedAt: 0 } as unknown as TerminalInfo['session']) : null
});
const WS: WorkspacesState = {
  on: true, active: 'A',
  list: [
    { id: 'A', name: 'Auth', color: 1, folder: null, order: ['t:a', 't:sh'], active: 't:a', layout: null },
    { id: 'B', name: 'Billing', color: 2, folder: null, order: ['t:b'], active: 't:b', layout: null, open: true },
    { id: 'C', name: 'Docs', color: 4, folder: null, order: [], active: null, layout: null }
  ],
  members: { a: 'A', sh: 'A', b: 'B' }
};
// A server render reads the store's initial state (useSyncExternalStore's server snapshot): it is given the current one
// (this file's own store instance).
const html = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(Sidebar));
};
const count = (s: string, needle: string) => s.split(needle).length - 1;

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, activity: 'sessions', tabOrder: [], selectedId: null,
    activeTab: 'term', hidden: [], split: single(), ws: WS, resumables: [], pins: [], bulkResume: null, groupByState: false,
    terminals: [term('a', true), term('sh', false), term('b', true)]
  });
});

test('every workspace a group; open ones show their rows, without the Sessions and Terminals labels', () => {
  const out = html();
  expect(count(out, 'class="ws-group')).toBe(3);
  expect(count(out, 'class="ws-body"')).toBe(2);
  expect(out).not.toContain('>Sessions<');
  expect(out).not.toContain('>Terminals<');
  // Group by state sits in the Workspaces head, next to its "+".
  expect(count(out, 'group-toggle')).toBe(1);
  // The empty, folded Docs: no body; an open empty one says how to start.
  useApp.setState({ ws: { ...WS, list: WS.list.map((w) => (w.id === 'C' ? { ...w, open: true } : w)) } });
  expect(html()).toContain('Empty. + starts a session here.');
});

test('numbers on the macro areas only: Workspaces has its count; the state heads and a folded workspace\'s dot have none', () => {
  const working = (id: string): TerminalInfo => ({ ...term(id, true), session: { ...term(id, true).session!, state: 'running' } });
  useApp.setState({ groupByState: true, terminals: [working('a'), term('sh', false), working('b')] });
  const out = html();
  expect(out).toMatch(/Workspaces<\/span><span class="count mono">3<\/span>/);
  // Grouped by state: the heads say the state, no number beside it.
  expect(out).toContain('class="inbox-head');
  expect(out).not.toMatch(/inbox-head[^>]*>(?:(?!<\/div>).)*class="count/);
  // Billing folded: its dot, no number (the tooltip says how many).
  useApp.setState({ ws: { ...WS, list: WS.list.map((w) => (w.id === 'B' ? { ...w, open: false } : w)) } });
  const folded = html();
  expect(folded).toContain('class="ws-dot is-working"');
  expect(folded).not.toContain('ws-dot-n');
});

test('Resume all\'s progress shows once, however many groups are open', () => {
  useApp.setState({ bulkResume: { total: 3, done: 1, queue: ['x'], stopped: false } as never });
  expect(count(html(), 'class="resume-run"')).toBe(1);
});

test('workspaces off: Sessions with Group by state and "+", Terminals with its "+"', () => {
  useApp.setState({ ws: { ...WS, on: false } });
  const out = html();
  expect(out).toContain('>Sessions<');
  expect(out).toContain('aria-label="New session"');
  expect(out).toContain('aria-label="New terminal"');
  expect(out).not.toContain('ws-group');
});
