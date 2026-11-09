import { expect, test } from 'vitest';
import { SHARED_TREE_MS, sharedReader } from './shared-tree';

test('reads within SHARED_TREE_MS share one ps (ports, background work, Redis clients); later ones read again', async () => {
  let t = 0;
  let reads = 0;
  const read = sharedReader(async () => { reads += 1; return new Map([[1, [reads]]]); }, () => t);
  const a = await read();
  t = SHARED_TREE_MS - 1;
  const b = await read();
  expect(reads).toBe(1);
  expect(b).toBe(a);
  t = SHARED_TREE_MS;
  await read();
  expect(reads).toBe(2);
});

test('a read in flight is shared too; a failed one is not kept (the next caller tries again)', async () => {
  let reads = 0;
  let fail = true;
  const read = sharedReader(async () => { reads += 1; if (fail) throw new Error('ps timed out'); return new Map<number, number[]>(); }, () => 0);
  const [x, y] = await Promise.allSettled([read(), read()]);
  expect(reads).toBe(1);
  expect(x.status).toBe('rejected');
  expect(y.status).toBe('rejected');
  fail = false;
  await read();
  expect(reads).toBe(2);
});
