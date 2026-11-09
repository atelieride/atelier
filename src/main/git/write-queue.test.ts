import { expect, test } from 'vitest';
import { WriteQueue } from './write-queue';

/** A job that starts (records its id) and finishes only when told to. */
function gated() {
  const started: string[] = [];
  const gates = new Map<string, { ok: () => void; fail: () => void }>();
  const job = (id: string) => () => new Promise<string>((res, rej) => {
    started.push(id);
    gates.set(id, { ok: () => res(id), fail: () => rej(new Error(`${id} failed`)) });
  });
  return { started, job, ok: (id: string) => gates.get(id)!.ok(), fail: (id: string) => gates.get(id)!.fail() };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('one job at a time per common dir, in the order asked', async () => {
  const q = new WriteQueue();
  const g = gated();
  const a = q.run('/r/.git', g.job('a'));
  const b = q.run('/r/.git', g.job('b'));
  const c = q.run('/r/.git', g.job('c'));
  await tick();
  expect(g.started).toEqual(['a']);
  g.ok('a');
  expect(await a).toBe('a');
  await tick();
  expect(g.started).toEqual(['a', 'b']);
  g.ok('b');
  await b;
  await tick();
  expect(g.started).toEqual(['a', 'b', 'c']);
  g.ok('c');
  expect(await c).toBe('c');
});

test('different common dirs run in parallel', async () => {
  const q = new WriteQueue();
  const g = gated();
  void q.run('/r/.git', g.job('r'));
  void q.run('/s/.git', g.job('s'));
  await tick();
  expect(g.started).toEqual(['r', 's']);
  expect(q.running().map((x) => x.common).sort()).toEqual(['/r/.git', '/s/.git']);
  g.ok('r');
  g.ok('s');
});

test('a failing job (rejected or thrown) does not block the next; its caller gets the error', async () => {
  const q = new WriteQueue();
  const g = gated();
  const a = q.run('/r/.git', g.job('a'));
  const thrown = q.run('/r/.git', () => { throw new Error('sync throw'); });
  const c = q.run('/r/.git', g.job('c'));
  await tick();
  g.fail('a');
  await expect(a).rejects.toThrow('a failed');
  await expect(thrown).rejects.toThrow('sync throw');
  await tick();
  expect(g.started).toEqual(['a', 'c']);
  g.ok('c');
  expect(await c).toBe('c');
});

test('busy and running: queued or running per common dir; fetches are not counted as running writes', async () => {
  const q = new WriteQueue();
  const g = gated();
  expect(q.busy('/r/.git')).toBe(false);
  const f = q.run('/r/.git', g.job('fetch'), 'fetch');
  const w = q.run('/r/.git', g.job('write'));
  await tick();
  expect(q.busy('/r/.git')).toBe(true);
  expect(q.busy('/s/.git')).toBe(false);
  // The fetch runs, the write waits: nothing a quit dialog has to name yet.
  expect(q.running()).toEqual([]);
  g.ok('fetch');
  await f;
  await tick();
  expect(q.running()).toEqual([{ common: '/r/.git' }]);
  g.ok('write');
  await w;
  await tick();
  expect(q.busy('/r/.git')).toBe(false);
  expect(q.running()).toEqual([]);
});

test('a fetch asked after a write starts once the write is done', async () => {
  const q = new WriteQueue();
  const g = gated();
  void q.run('/r/.git', g.job('commit'));
  const f = q.run('/r/.git', g.job('fetch'), 'fetch');
  await tick();
  expect(g.started).toEqual(['commit']);
  g.ok('commit');
  await tick();
  await tick();
  expect(g.started).toEqual(['commit', 'fetch']);
  g.ok('fetch');
  expect(await f).toBe('fetch');
});

test('idle: resolves once nothing runs or waits on that common dir (jobs asked meanwhile included)', async () => {
  const q = new WriteQueue();
  const g = gated();
  let idle = false;
  await q.idle('/r/.git');
  void q.run('/r/.git', g.job('a'));
  void q.idle('/r/.git').then(() => { idle = true; });
  await tick();
  void q.run('/r/.git', g.job('b'));
  g.ok('a');
  await tick(); await tick();
  expect(g.started).toEqual(['a', 'b']);
  expect(idle).toBe(false);
  g.ok('b');
  await tick(); await tick();
  expect(idle).toBe(true);
  expect(q.busy('/r/.git')).toBe(false);
});

