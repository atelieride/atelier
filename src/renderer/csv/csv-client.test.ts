import { expect, test } from 'vitest';
import { createCsvParser, type CsvReply, type CsvRequest } from './csv-client';
import type { WorkerLike } from '../editor/highlighter';
import { AUTO_OPTIONS } from './types';

/** A worker that answers when told to. */
function fake() {
  const sent: (CsvRequest & { id: number })[] = [];
  let w: WorkerLike | null = null;
  const make = (): WorkerLike => {
    w = { onmessage: null, postMessage: (m) => { sent.push(m as CsvRequest & { id: number }); }, terminate: () => {} };
    return w;
  };
  const answer = (k = 0) => {
    const job = sent[k]!;
    const reply = { id: job.id, result: { text: job.text }, ms: 4 } as unknown as CsvReply;
    w!.onmessage!({ data: reply } as MessageEvent);
  };
  return { sent, make, answer };
}

const req = (text: string): CsvRequest => ({ text, options: AUTO_OPTIONS, hint: 'csv', rows: true });

test('one job at a time; each request gets its result and the time it took', async () => {
  const f = fake();
  const p = createCsvParser(f.make);
  const a = p.parse(req('a,b'), 'x');
  const b = p.parse({ ...req('c;d'), hint: 'tsv' }, 'y');
  expect(f.sent.map((s) => s.text)).toEqual(['a,b']);
  f.answer(0);
  expect(await a).toEqual({ result: { text: 'a,b' }, ms: 4 });
  expect(f.sent.map((s) => [s.text, s.hint])).toEqual([['a,b', 'csv'], ['c;d', 'tsv']]);
  f.answer(1);
  expect(await b).toMatchObject({ ms: 4 });
});

test('a newer request of the same editor replaces the waiting one and drops the running one; cancel drops', async () => {
  const f = fake();
  const p = createCsvParser(f.make);
  const first = p.parse(req('1'), 'ed');
  const second = p.parse(req('2'), 'ed');
  const third = p.parse(req('3'), 'ed');
  expect(await second).toBe('dropped');
  f.answer(0);
  expect(await first).toBe('dropped');
  expect(f.sent.map((s) => s.text)).toEqual(['1', '3']);
  p.cancel('ed');
  f.answer(1);
  expect(await third).toBe('dropped');
});

test('a worker that fails: the running job is dropped and the queue goes on with a new worker (review)', async () => {
  const made: WorkerLike[] = [];
  const sent: { id: number; text: string }[] = [];
  const p = createCsvParser(() => {
    const w: WorkerLike = { onmessage: null, postMessage: (m) => { sent.push(m as { id: number; text: string }); }, terminate: () => {} };
    made.push(w);
    return w;
  });
  const a = p.parse(req('a'), 'x');
  const b = p.parse(req('b'), 'y');
  (made[0] as unknown as { onerror: (e: unknown) => void }).onerror(new Event('error'));
  expect(await a).toBe('dropped');
  expect(made).toHaveLength(2);
  expect(sent.map((s) => s.text)).toEqual(['a', 'b']);
  made[1]!.onmessage!({ data: { id: sent[1]!.id, result: { text: 'b' }, ms: 1 } } as MessageEvent);
  expect(await b).toMatchObject({ ms: 1 });
});
