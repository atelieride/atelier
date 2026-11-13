import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from './store';
import type { TabKey } from './tabs-model';
import type { WorkspacesState } from './workspaces';
import type { Band } from './row-order';

// The sidebar's own order in the store: loaded with the pins, moved by a drop or Move Up/Down, kept through prune and
// resume, dropped for a row moved by hand to another place.

const term = (id: string): TerminalInfo => ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'zsh', createdAt: 0, session: null });
const res = (id: string) => ({ id, projectRoot: '/p', cwd: '/p', title: id, color: '#fff', sessionId: `s-${id}`, endedAt: 0 });
const st = () => useApp.getState();
const unpinned = (...ids: string[]): Band => ({ kind: 'sessions', pinned: false, ids });

describe('row order', () => {
  const g = globalThis as { localStorage?: unknown; window?: unknown };
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map([['atelier.order', JSON.stringify({ '/p': { sessions: ['b', 'a', 'gone'], terminals: [] }, '/other': { sessions: ['x'], terminals: [] } })]]);
    g.localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    useApp.setState({ terminals: [], pins: [], resumables: [], resumablesKnown: false, project: null, layoutRestored: true, ws: null });
  });
  afterEach(() => {
    delete g.localStorage; delete g.window;
    useApp.setState({ project: null, pins: [], resumables: [], ws: null, rowOrder: { sessions: [], terminals: [] } });
  });

  test('loaded per project, reordered and saved; a stay-put drop saves nothing', () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ terminals: ['a', 'b', 'c'].map(term) });
    expect(st().rowOrder.sessions).toEqual(['b', 'a', 'gone']);
    st().reorderRow(unpinned('b', 'a', 'c'), 'c', 'b');
    expect(st().rowOrder.sessions).toEqual(['c', 'b', 'a', 'gone']);
    expect(JSON.parse(saved.get('atelier.order')!)['/p']).toEqual({ sessions: ['c', 'b', 'a', 'gone'], terminals: [] });
    const before = saved.get('atelier.order');
    st().reorderRow(unpinned('c', 'b', 'a'), 'b', 'a');
    expect(saved.get('atelier.order')).toBe(before);
    expect(st().rowOrder.sessions).toEqual(['c', 'b', 'a', 'gone']);
  });

  test('a terminals band writes the terminals list only', () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ terminals: ['s1', 's2'].map(term) });
    st().reorderRow({ kind: 'terminals', pinned: false, ids: ['s1', 's2'] }, 's2', 's1');
    expect(st().rowOrder).toEqual({ sessions: ['b', 'a', 'gone'], terminals: ['s2', 's1'] });
  });

  test('pinned band: reorderRow moves the id inside pins; the manual order stays', () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ pins: ['p1', 'x', 'p2'] });
    st().reorderRow({ kind: 'sessions', pinned: true, ids: ['p1', 'p2'] }, 'p2', 'p1');
    expect(st().pins).toEqual(['p2', 'p1', 'x']);
    expect(st().rowOrder.sessions).toEqual(['b', 'a', 'gone']);
  });

  test('a band read before a row closed never writes the closed row back', () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ terminals: [term('a'), term('c')], pins: ['p1', 'p2'], rowOrder: { sessions: [], terminals: [] } });
    // b closed after the menu or the drag read the band.
    st().reorderRow(unpinned('a', 'b', 'c'), 'c', 'a');
    expect(st().rowOrder.sessions).toEqual(['c', 'a']);
    useApp.setState({ terminals: [term('a'), term('c'), term('p2')] });
    st().reorderRow({ kind: 'sessions', pinned: true, ids: ['p1', 'p2'] }, 'p2', 'p1');
    expect(st().pins).toEqual(['p2', 'p1']);
    useApp.setState({ pins: ['p2'] });
    st().reorderRow({ kind: 'sessions', pinned: true, ids: ['p1', 'p2', 'p3'] }, 'p3', 'p1');
    expect(st().pins).toEqual(['p2']);
  });

  test('moveRowStep: up, down, nothing at the ends', () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ terminals: ['a', 'b'].map(term) });
    st().moveRowStep(unpinned('b', 'a'), 'a', -1);
    expect(st().rowOrder.sessions).toEqual(['a', 'b', 'gone']);
    st().moveRowStep(unpinned('a', 'b'), 'a', 1);
    expect(st().rowOrder.sessions).toEqual(['b', 'a', 'gone']);
    st().moveRowStep(unpinned('b', 'a'), 'b', -1);
    st().moveRowStep(unpinned('b', 'a'), 'a', 1);
    expect(st().rowOrder.sessions).toEqual(['b', 'a', 'gone']);
  });

  test('pruned like the pins (only once the resumables are known, never by an empty list), relinked on resume', async () => {
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    st().setTerminals([]);
    st().setTerminals([term('a'), term('b')]);
    expect(st().rowOrder.sessions).toEqual(['b', 'a', 'gone']);
    st().setResumables([]);
    expect(st().rowOrder.sessions).toEqual(['b', 'a']);
    expect(JSON.parse(saved.get('atelier.order')!)['/p'].sessions).toEqual(['b', 'a']);
    // Resumed: the new terminal takes the old one's place, even when the lists arrive before the reply.
    st().setResumables([res('b')]);
    st().setTerminals([term('a')]);
    let reply: (info: TerminalInfo) => void = () => {};
    g.window = { atelier: { terminals: { resume: vi.fn(() => new Promise<TerminalInfo>((r) => { reply = r; })) } } };
    const done = st().resume('b');
    st().setResumables([]);
    st().setTerminals([term('a'), term('b2')]);
    expect(st().rowOrder.sessions).toEqual(['b', 'a']);
    reply(term('b2'));
    await done;
    expect(st().rowOrder.sessions).toEqual(['b2', 'a']);
  });

  test('a hand move to another workspace un-places the row; a move onto its own place does not', () => {
    const ws: WorkspacesState = {
      on: true, active: 'A', members: { a: 'A', b: 'B' },
      list: [
        { id: 'A', name: 'A', color: 1, folder: null, order: ['t:a'] as TabKey[], active: 't:a', layout: null },
        { id: 'B', name: 'B', color: 2, folder: null, order: ['t:b'] as TabKey[], active: 't:b', layout: null }
      ]
    };
    st().setProject({ root: '/p', name: 'p', realRoot: '/p' });
    useApp.setState({ ws, rowOrder: { sessions: ['a', 'b'], terminals: ['a'] } });
    st().setTerminals([term('a'), term('b')]);
    st().moveToWorkspace('t:b', 'B', { quiet: true });
    expect(st().rowOrder).toEqual({ sessions: ['a', 'b'], terminals: ['a'] });
    // From the workspace in front, and from one that is not.
    st().moveToWorkspace('t:a', 'B', { quiet: true });
    expect(st().rowOrder).toEqual({ sessions: ['b'], terminals: [] });
    st().moveToWorkspace('t:b', 'A', { quiet: true });
    expect(st().rowOrder).toEqual({ sessions: [], terminals: [] });
  });
});
