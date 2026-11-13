import { beforeEach, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionState } from '@shared/session';
import { useApp } from '../store';
import { single } from '../split';
import { Sidebar } from './Sidebar';

// The sidebar in the order rows were put in by hand: unpinned rows by the manual order, pinned ones by pin order, and a
// band (data-band) on every row that can move.

const session = (id: string, createdAt: number, state: SessionState = 'idle'): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'claude', createdAt,
  session: { sessionId: id, state, title: null, activity: null, contextPct: null, unread: false, updatedAt: createdAt } as TerminalInfo['session']
});
const shell = (id: string, createdAt: number): TerminalInfo => ({
  id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt, session: null
});
const html = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(createElement(Sidebar));
};
/** Row ids in the order drawn, with their band attribute (null: none). */
const rows = (out: string, cls: 'session-row' | 'term-row') =>
  [...out.matchAll(/<div[^>]*role="listitem"[^>]*>/g)].map((m) => m[0])
    .filter((tag) => new RegExp(`class="${cls}\\b`).test(tag))
    .map((tag) => [/data-term-row="([^"]+)"/.exec(tag)![1], /data-band="([^"]+)"/.exec(tag)?.[1] ?? null]);
const ids = (out: string, cls: 'session-row' | 'term-row') => rows(out, cls).map(([id]) => id);

beforeEach(() => {
  useApp.setState({
    project: { root: '/p', name: 'p', realRoot: '/p' }, popout: null, activity: 'sessions', tabOrder: [], selectedId: null,
    activeTab: 'term', hidden: [], split: single(), ws: null, resumables: [], pins: [], bulkResume: null, groupByState: false,
    starting: {}, rowOrder: { sessions: [], terminals: [] },
    terminals: [session('a', 1), session('b', 2), session('c', 3), shell('s1', 1), shell('s2', 2), shell('s3', 3)]
  });
});

test('grouping off: sessions and terminals in manual order, unplaced at the bottom by age, pinned first', () => {
  useApp.setState({ rowOrder: { sessions: ['c', 'a'], terminals: ['s3'] }, pins: ['b'] });
  const out = html();
  expect(ids(out, 'session-row')).toEqual(['b', 'c', 'a']);
  expect(ids(out, 'term-row')).toEqual(['s3', 's1', 's2']);
  // Without an order: oldest first.
  useApp.setState({ rowOrder: { sessions: [], terminals: [] }, pins: [] });
  expect(ids(html(), 'session-row')).toEqual(['a', 'b', 'c']);
});

test('every row of a band of two or more carries it; a band of one row has none', () => {
  useApp.setState({ pins: ['b'] });
  const out = html();
  expect(rows(out, 'session-row')).toEqual([['b', null], ['a', 'sessions:unpinned'], ['c', 'sessions:unpinned']]);
  useApp.setState({ terminals: [session('a', 1), session('b', 2), shell('s1', 1)], pins: ['a', 'b'] });
  const two = html();
  expect(rows(two, 'session-row')).toEqual([['a', 'sessions:pinned'], ['b', 'sessions:pinned']]);
  expect(rows(two, 'term-row')).toEqual([['s1', null]]);
});

test('grouping on: only Idle rows have a band; Working rows have none', () => {
  useApp.setState({
    groupByState: true, rowOrder: { sessions: ['a', 'c'], terminals: [] },
    terminals: [session('a', 1), session('b', 2), session('c', 3), session('r1', 4, 'running'), session('r2', 5, 'running')]
  });
  const out = html();
  expect(rows(out, 'session-row')).toEqual([
    ['r2', null], ['r1', null], ['b', 'sessions:unpinned'], ['a', 'sessions:unpinned'], ['c', 'sessions:unpinned']
  ]);
});

test('a shell placed only among the sessions arrives at the bottom of Terminals; unpinned, a row returns to its place', () => {
  useApp.setState({ terminals: [shell('s1', 1), shell('s2', 2), shell('x', 3)], rowOrder: { sessions: ['x'], terminals: ['s2', 's1'] } });
  expect(ids(html(), 'term-row')).toEqual(['s2', 's1', 'x']);
  useApp.setState({
    terminals: [session('a', 1), session('b', 2), session('c', 3)], rowOrder: { sessions: ['c', 'b', 'a'], terminals: [] }, pins: ['b']
  });
  expect(ids(html(), 'session-row')).toEqual(['b', 'c', 'a']);
  useApp.setState({ pins: [] });
  expect(ids(html(), 'session-row')).toEqual(['c', 'b', 'a']);
});
