import { expect, test } from 'vitest';
import type { ServerMessage } from '@shared/protocol';
import { DaemonClient } from './daemon-client';

// Moved terminals: every listener of atelierd's terminal and resumable
// lists gets them relabelled, and a move sends the last ones again at once.

const dispatch = (c: DaemonClient, m: unknown) => (c as unknown as { dispatch(m: ServerMessage): void }).dispatch(m as ServerMessage);
const term = (id: string, projectRoot: string) => ({ id, projectRoot, cwd: projectRoot, title: id, name: null, color: '#fff', foreground: 'zsh', createdAt: 0, session: null });

test('lists go out relabelled; reemit sends the last ones again with the relabel as it is now', () => {
  const c = new DaemonClient(async () => { throw new Error('no daemon in a unit test'); });
  const got: { terminals: unknown[][]; resumables: unknown[][] } = { terminals: [], resumables: [] };
  c.on('terminals', (l: unknown[]) => got.terminals.push(l));
  c.on('resumables', (l: unknown[]) => got.resumables.push(l));
  c.reemit();
  expect(got).toEqual({ terminals: [], resumables: [] });
  let to = '/a';
  c.setRelabel((list) => list.map((x) => (x.id === 't1' ? { ...x, projectRoot: to } : x)));
  dispatch(c, { t: 'terminals', list: [term('t1', '/a'), term('t2', '/a')] });
  dispatch(c, { t: 'resumables', list: [{ id: 't1', projectRoot: '/a' }] });
  to = '/b';
  c.reemit();
  expect(got.terminals.map((l) => l.map((x) => (x as { projectRoot: string }).projectRoot))).toEqual([['/a', '/a'], ['/b', '/a']]);
  expect(got.resumables.map((l) => l.map((x) => (x as { projectRoot: string }).projectRoot))).toEqual([['/a'], ['/b']]);
  // Atelierd gone, its lists go too — a move meanwhile never re-sends what it had.
  (c as unknown as { onClosed(): void }).onClosed();
  c.stop();
  c.reemit();
  expect(got.terminals).toHaveLength(2);
  expect(c.listedProject('t1')).toBeNull();
});
