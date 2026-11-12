import { expect, test } from 'vitest';
import { inLanes } from './lanes';

// Bulk git runs (Sync All, Pull All, Push All) go a few repositories at a time: one lane per object store, so the
// worktrees of one repository go one after another and never hold two of the few slots for one write.

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Jobs that end when the test says: `running` is what has started and not ended yet. */
function jobs() {
  const started: string[] = [];
  const running = new Set<string>();
  const ends = new Map<string, (fail?: Error) => void>();
  const fn = (item: { id: string }) => new Promise<void>((resolve, reject) => {
    started.push(item.id);
    running.add(item.id);
    ends.set(item.id, (fail) => { running.delete(item.id); if (fail) reject(fail); else resolve(); });
  });
  const end = async (id: string, fail?: Error) => { ends.get(id)!(fail); await flush(); };
  return { started, running, fn, end };
}

const item = (id: string, lane = id) => ({ id, lane });

test('at most `limit` lanes run at once; the next lane starts as soon as one ends, in the order given', async () => {
  const j = jobs();
  const all = inLanes(['a', 'b', 'c', 'd', 'e', 'f'].map((x) => item(x)), (x) => x.lane, 4, j.fn);
  await flush();
  expect(j.started).toEqual(['a', 'b', 'c', 'd']);
  await j.end('c');
  expect(j.started).toEqual(['a', 'b', 'c', 'd', 'e']);
  await j.end('a');
  expect([...j.running].sort()).toEqual(['b', 'd', 'e', 'f']);
  for (const id of ['b', 'd', 'e', 'f']) await j.end(id);
  await all;
});

test('items of one lane run one after another, in their order, and the lane keeps its slot: other lanes are not held up', async () => {
  const j = jobs();
  // a and a-wt share an object store: given together, they still take one slot of the two.
  const all = inLanes([item('a', 'A'), item('a-wt', 'A'), item('b', 'B'), item('c', 'C')], (x) => x.lane, 2, j.fn);
  await flush();
  expect(j.started).toEqual(['a', 'b']);
  await j.end('a');
  expect(j.started).toEqual(['a', 'b', 'a-wt']);
  await j.end('b');
  expect(j.started).toEqual(['a', 'b', 'a-wt', 'c']);
  await j.end('a-wt');
  await j.end('c');
  await all;
});

test('a job that fails stops nothing: every other item still runs, then the run rejects with the first failure', async () => {
  const j = jobs();
  const all = inLanes([item('a', 'A'), item('a2', 'A'), item('b')], (x) => x.lane, 2, j.fn);
  const settled = all.then(() => 'resolved', (e: Error) => e.message);
  await flush();
  await j.end('a', new Error('first'));
  await j.end('b', new Error('second'));
  expect(j.started).toEqual(['a', 'b', 'a2']);
  await j.end('a2');
  expect(await settled).toBe('first');
});

test('nothing to run, or a limit below one: it still ends, one lane at a time at worst', async () => {
  await expect(inLanes([], () => '', 4, async () => {})).resolves.toBeUndefined();
  const j = jobs();
  const all = inLanes([item('a'), item('b')], (x) => x.lane, 0, j.fn);
  await flush();
  expect(j.started).toEqual(['a']);
  await j.end('a');
  await j.end('b');
  await all;
});
