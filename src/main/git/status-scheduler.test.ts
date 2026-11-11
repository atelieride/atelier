// StatusScheduler with the read limiter: which repository's status is read first when many wait, and what a request
// does to a read already waiting for a slot.
import { expect, test } from 'vitest';
import type { RepoStatus } from '@shared/git';
import { ReadLimiter } from './read-limiter';
import { StatusScheduler } from './service';

/** A status read that ends when told to; records the order reads started in. */
function fakeReads() {
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const read = (repo: string) => new Promise<RepoStatus>((resolve) => {
    started.push(repo);
    pending.set(repo, () => resolve({ root: repo, name: repo, branch: 'main', detached: false, ahead: 0, behind: 0, oid: null, changes: [], checkedAt: Date.now(), truncated: 0 }));
  });
  const finish = async (repo: string) => { const f = pending.get(repo)!; pending.delete(repo); f(); await settle(); };
  return { started, read, finish };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

function scheduler(slots = 1) {
  const r = fakeReads();
  const s = new StatusScheduler(r.read, 0, new ReadLimiter(slots));
  return { s, ...r };
}

test('a live request is read before bulk ones made earlier', async () => {
  const { s, started, finish } = scheduler();
  s.request('/busy');
  for (const repo of ['/a', '/b', '/c']) s.request(repo, { bulk: true });
  s.request('/d');
  await settle();
  await finish('/busy');
  expect(started).toEqual(['/busy', '/d']);
  await finish('/d');
  expect(started).toEqual(['/busy', '/d', '/a']);
});

test('a live request for a repository already waiting as bulk promotes it, without a second read', async () => {
  const { s, started, finish } = scheduler();
  s.request('/busy');
  s.request('/a', { bulk: true });
  s.request('/b', { bulk: true });
  s.request('/b');
  await settle();
  await finish('/busy');
  expect(started).toEqual(['/busy', '/b']);
  await finish('/b');
  await finish('/a');
  expect(started).toEqual(['/busy', '/b', '/a']);
});

test('soon starts a waiting read at once, all slots busy or not', async () => {
  const { s, started } = scheduler();
  s.request('/busy');
  s.request('/a', { bulk: true });
  s.request('/a', { soon: true });
  await settle();
  expect(started).toEqual(['/busy', '/a']);
});

test('soon with nothing waiting reads at once without a slot', async () => {
  const { s, started } = scheduler();
  s.request('/busy');
  s.request('/x', { soon: true });
  await settle();
  expect(started).toEqual(['/busy', '/x']);
});

test('a request while the read runs queues exactly one follow-up', async () => {
  const { s, started, finish } = scheduler(4);
  s.request('/a');
  await settle();
  s.request('/a');
  s.request('/a', { bulk: true });
  s.request('/a');
  await finish('/a');
  expect(started).toEqual(['/a', '/a']);
  await finish('/a');
  expect(started).toEqual(['/a', '/a']);
});

test('a repository forgotten (gone from the project, then back) is read at once, not spaced from its old reads', async () => {
  const r = fakeReads();
  const s = new StatusScheduler(r.read, 10_000, new ReadLimiter(4));
  s.request('/a');
  await settle();
  await r.finish('/a');
  s.forget('/a');
  s.request('/a');
  await settle();
  expect(r.started).toEqual(['/a', '/a']);
});

test('a follow-up read asked only as bulk stays bulk: it waits behind live reads', async () => {
  const { s, started, finish } = scheduler(1);
  s.request('/a');
  await settle();
  // While /a reads: a bulk request for it and for /c (a rescan), and live work elsewhere.
  s.request('/a', { bulk: true });
  s.request('/c', { bulk: true });
  s.request('/busy');
  await finish('/a');
  await finish('/busy');
  await finish('/c');
  // /a's follow-up queued behind /c, as the bulk read it was asked as.
  expect(started).toEqual(['/a', '/busy', '/c', '/a']);
});

test('requests for a read still waiting add nothing', async () => {
  const { s, started, finish } = scheduler();
  s.request('/busy');
  s.request('/a', { bulk: true });
  s.request('/a', { bulk: true });
  await settle();
  await finish('/busy');
  await finish('/a');
  expect(started).toEqual(['/busy', '/a']);
});
