import { expect, test } from 'vitest';
import { createJsonParser, type ParseReply } from './json-client';
import type { WorkerLike } from '../editor/highlighter';

/** A worker that answers when told to. */
function fake() {
  const sent: { id: number; text: string; jsonc: boolean }[] = [];
  let w: WorkerLike | null = null;
  const make = (): WorkerLike => {
    w = { onmessage: null, postMessage: (m) => { sent.push(m as { id: number; text: string; jsonc: boolean }); }, terminate: () => {} };
    return w;
  };
  const answer = (k = 0) => {
    const job = sent[k]!;
    const reply: ParseReply = { id: job.id, result: { ok: false, empty: true }, ms: 3 };
    w!.onmessage!({ data: reply } as MessageEvent);
  };
  return { sent, make, answer };
}

test('one job at a time; each request gets its result and the time it took', async () => {
  const f = fake();
  const p = createJsonParser(f.make);
  const a = p.parse('[1]', false, 'a');
  const b = p.parse('[2]', true, 'b');
  expect(f.sent.map((s) => s.text)).toEqual(['[1]']);
  f.answer(0);
  expect(await a).toEqual({ result: { ok: false, empty: true }, ms: 3 });
  expect(f.sent.map((s) => [s.text, s.jsonc])).toEqual([['[1]', false], ['[2]', true]]);
  f.answer(1);
  expect(await b).toMatchObject({ ms: 3 });
});

test('a newer request of the same editor replaces the waiting one and drops the running one', async () => {
  const f = fake();
  const p = createJsonParser(f.make);
  const first = p.parse('1', false, 'ed');
  const second = p.parse('2', false, 'ed');
  const third = p.parse('3', false, 'ed');
  expect(await second).toBe('dropped');
  f.answer(0);
  expect(await first).toBe('dropped');
  expect(f.sent.map((s) => s.text)).toEqual(['1', '3']);
  f.answer(1);
  expect(await third).toMatchObject({ ms: 3 });
});

test('cancel: a closed editor\'s requests are dropped', async () => {
  const f = fake();
  const p = createJsonParser(f.make);
  const run = p.parse('1', false, 'x');
  const wait = p.parse('2', false, 'y');
  p.cancel('y');
  expect(await wait).toBe('dropped');
  p.cancel('x');
  f.answer(0);
  expect(await run).toBe('dropped');
});
