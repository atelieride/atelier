import { expect, test } from 'vitest';
import { TerminalHomes, normalizeHomes } from './terminal-homes';

// Terminals moved to another project's window: main keeps their new
// project and relabels atelierd's lists with it; atelierd never changes.

const term = (id: string, projectRoot = '/a') => ({ id, projectRoot, cwd: projectRoot, title: id });

test('relabel: a moved terminal (and its resume entry) reads as its new project; the rest, and an empty map, untouched', () => {
  const saved: Record<string, string>[] = [];
  const homes = new TerminalHomes({}, (h) => saved.push(h));
  const list = [term('t1'), term('t2')];
  expect(homes.relabel(list)).toBe(list);
  homes.set('t1', '/a', '/b');
  expect(homes.relabel(list)).toEqual([{ ...term('t1'), projectRoot: '/b' }, term('t2')]);
  expect(list[0]!.projectRoot).toBe('/a');
  expect(homes.relabel([{ id: 't1', projectRoot: '/a', sessionId: 's' }])).toEqual([{ id: 't1', projectRoot: '/b', sessionId: 's' }]);
  expect(saved.at(-1)).toEqual({ t1: '/b' });
});

test('moved back to the project atelierd knows it by: no home left', () => {
  const homes = new TerminalHomes({ t1: '/b' }, () => {});
  homes.set('t1', '/a', '/a');
  expect(homes.relabel([term('t1')])).toEqual([term('t1')]);
  expect(homes.snapshot()).toEqual({});
});

test('prune: homes of terminals atelierd no longer lists (nor keeps to resume) go, saved once', () => {
  const saved: Record<string, string>[] = [];
  const homes = new TerminalHomes({ t1: '/b', t2: '/c', t3: '/d' }, (h) => saved.push(h));
  homes.prune(['t1', 'x'], ['t3']);
  expect(homes.snapshot()).toEqual({ t1: '/b', t3: '/d' });
  expect(saved).toEqual([{ t1: '/b', t3: '/d' }]);
  homes.prune(['t1', 't3'], []);
  expect(saved).toHaveLength(1);
});

test('normalize: ids and absolute roots only, at most 500', () => {
  expect(normalizeHomes({ t1: '/b', t2: 'rel', 3: '/c', t4: 7, ['x'.repeat(200)]: '/e' })).toEqual({ 3: '/c', t1: '/b' });
  expect(normalizeHomes(null)).toEqual({});
  expect(normalizeHomes(['/a'])).toEqual({});
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`t${i}`, '/p']));
  expect(Object.keys(normalizeHomes(many))).toHaveLength(500);
});

// A moved terminal's session resumed in its new window. atelierd makes a new terminal
// (a new id) in the project it stored: the new id gets the same home, and the reply reads as that project already.
test('resumed: the new terminal of a moved one\'s resume entry keeps its home; one never moved is left alone', () => {
  const homes = new TerminalHomes({ old: '/b' }, () => {});
  const info = { id: 'new', projectRoot: '/a', cwd: '/a', title: 'x' };
  expect(homes.resumed('old', info)).toEqual({ ...info, projectRoot: '/b' });
  expect(homes.get('new')).toBe('/b');
  expect(homes.relabel([info])).toEqual([{ ...info, projectRoot: '/b' }]);
  const other = { id: 'n2', projectRoot: '/a', cwd: '/a', title: 'y' };
  expect(homes.resumed('never-moved', other)).toBe(other);
  expect(homes.get('n2')).toBeUndefined();
});
