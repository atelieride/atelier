import { expect, test } from 'vitest';
import { ACT_MIME, ROW_MIME, fromType, placeDrop } from './place-drop';

// What a sidebar drop target takes: rows of another place; a whole activity only on another workspace's head.

const row = (from: string) => [ROW_MIME, fromType(from)];
const act = (ws: string) => [ACT_MIME, fromType(ws)];

test('a row goes onto any other place: a workspace head, its own rows, an activity', () => {
  expect(placeDrop(row('a1'), { id: 'A', kind: 'workspace' })).toBe('row');
  expect(placeDrop(row('a1'), { id: 'A', kind: 'own' })).toBe('row');
  expect(placeDrop(row('A'), { id: 'a2', kind: 'activity' })).toBe('row');
  expect(placeDrop(row('B'), { id: 'a1', kind: 'activity' })).toBe('row');
});

test('the place a row is in shows no drop state', () => {
  expect(placeDrop(row('A'), { id: 'A', kind: 'workspace' })).toBeNull();
  expect(placeDrop(row('A'), { id: 'A', kind: 'own' })).toBeNull();
  expect(placeDrop(row('a1'), { id: 'a1', kind: 'activity' })).toBeNull();
});

test('an activity\'s head goes only onto another workspace\'s head: never into an activity, never its own workspace', () => {
  expect(placeDrop(act('A'), { id: 'B', kind: 'workspace' })).toBe('activity');
  expect(placeDrop(act('A'), { id: 'A', kind: 'workspace' })).toBeNull();
  expect(placeDrop(act('A'), { id: 'b1', kind: 'activity' })).toBeNull();
  expect(placeDrop(act('A'), { id: 'B', kind: 'own' })).toBeNull();
});

test('anything else (files from Finder, text) is not a sidebar move', () => {
  expect(placeDrop(['Files'], { id: 'A', kind: 'workspace' })).toBeNull();
  expect(placeDrop([], { id: 'a1', kind: 'activity' })).toBeNull();
});

test('the from-type is lowercase (a drag over shows types lowercased)', () => {
  expect(fromType('wAbC1')).toBe('application/x-atelier-from-wabc1');
});
