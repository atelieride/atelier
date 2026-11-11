import { expect, test } from 'vitest';
import { ReadLimiter } from './read-limiter';

/** A read that finishes when told to, recording when it started. */
function reads() {
  const started: string[] = [];
  const done = new Map<string, (ok: boolean) => void>();
  const job = (name: string) => () => new Promise<string>((resolve, reject) => {
    started.push(name);
    done.set(name, (ok) => (ok ? resolve(name) : reject(new Error(name))));
  });
  const finish = async (name: string, ok = true) => { done.get(name)!(ok); await new Promise((r) => setTimeout(r, 0)); };
  return { started, job, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('never more than its slots at once, first come first served within a level', async () => {
  const l = new ReadLimiter(2);
  const r = reads();
  const all = ['a', 'b', 'c', 'd'].map((n) => l.run('live', r.job(n)));
  await tick();
  expect(r.started).toEqual(['a', 'b']);
  await r.finish('a');
  expect(r.started).toEqual(['a', 'b', 'c']);
  await r.finish('b'); await r.finish('c'); await r.finish('d');
  expect(await Promise.all(all)).toEqual(['a', 'b', 'c', 'd']);
});

test('live reads go before bulk ones queued earlier', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  void l.run('bulk', r.job('b1'));
  void l.run('bulk', r.job('b2'));
  void l.run('live', r.job('l1'));
  await tick();
  await r.finish('b1');
  expect(r.started).toEqual(['b1', 'l1']);
  await r.finish('l1');
  expect(r.started).toEqual(['b1', 'l1', 'b2']);
});

test('a queued bulk read promoted to live jumps the bulk queue', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  void l.run('live', r.job('busy'));
  void l.run('bulk', r.job('x'), 'x');
  void l.run('bulk', r.job('y'), 'y');
  l.promote('y', 'live');
  await tick();
  await r.finish('busy');
  expect(r.started).toEqual(['busy', 'y']);
});

test('a queued read promoted to now starts at once, every slot busy or not', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  void l.run('live', r.job('busy'));
  const now = l.run('bulk', r.job('urgent'), 'urgent');
  l.promote('urgent', 'now');
  await tick();
  expect(r.started).toEqual(['busy', 'urgent']);
  await r.finish('urgent');
  expect(await now).toBe('urgent');
  // It never held a slot: the next queued read still waits for busy.
  void l.run('live', r.job('next'));
  await tick();
  expect(r.started).toEqual(['busy', 'urgent']);
  await r.finish('busy');
  expect(r.started).toEqual(['busy', 'urgent', 'next']);
});

test('promoting a key nobody queued, or a read already running, changes nothing', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  void l.run('live', r.job('a'), 'a');
  void l.run('live', r.job('b'), 'b');
  await tick();
  l.promote('a', 'now');
  l.promote('ghost', 'now');
  await tick();
  expect(r.started).toEqual(['a']);
});

test('a failed read frees its slot and rejects its caller', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  const bad = expect(l.run('live', r.job('bad'))).rejects.toThrow('bad');
  const next = l.run('live', r.job('next'));
  await tick();
  await r.finish('bad', false);
  await bad;
  expect(r.started).toEqual(['bad', 'next']);
  await r.finish('next');
  expect(await next).toBe('next');
});

test('a read that throws before returning a promise frees its slot too', async () => {
  const l = new ReadLimiter(1);
  const r = reads();
  await expect(l.run('live', () => { throw new Error('sync'); })).rejects.toThrow('sync');
  void l.run('live', r.job('after'));
  await tick();
  expect(r.started).toEqual(['after']);
});
