import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RemotePairingEvent } from '@shared/remote';
import { deriveCode, parsePairUrl } from './code';
import { Pairing, type PairingDeps } from './pairing';

let codes: string[];
let events: RemotePairingEvent[];
let offers: [string, number][];
let withdrawn: string[];
let made: Pairing[];

beforeEach(() => { codes = ['7K4Q9MXD2HTR', 'ABCDEFGHJKMN', '000000000000', 'ZZZZZZZZZZZZ', '111111111111', '222222222222']; events = []; offers = []; withdrawn = []; made = []; });
// A pairing left running would keep renewing into the next test's arrays.
afterEach(() => { for (const p of made) p.stop(); });

function make(o: Partial<PairingDeps> = {}) {
  const p = new Pairing({
    offer: (l, t) => offers.push([l, t]), withdraw: (l) => withdrawn.push(l),
    relay: 'http://127.0.0.1:8787', hostKey: Buffer.alloc(32, 5), hostName: 'Studio Mac',
    emit: (e) => events.push(e), newCode: () => codes.shift()!, ...o
  });
  made.push(p);
  return p;
}

test('a code: shown in groups, its QR text, offered to the relay for its 5 minutes', async () => {
  const p = make();
  const shown = await p.current();
  const k = await deriveCode('7K4Q9MXD2HTR');
  expect(shown.code).toBe('7K4Q-9MXD-2HTR');
  expect(parsePairUrl(shown.qr)).toEqual({ code: '7K4Q9MXD2HTR', relay: 'http://127.0.0.1:8787', hostKey: Buffer.alloc(32, 5), name: 'Studio Mac' });
  expect(offers).toEqual([[k.lookup, 300]]);
  expect(p.codes()).toEqual([{ lookup: k.lookup, psk: k.psk }]);
  expect(events).toEqual([{ kind: 'code', pairing: shown }]);
  // Asked again: the same code while it lives.
  expect(await p.current()).toEqual(shown);
});

test('expired, a fresh code replaces it by itself; the old one is withdrawn', async () => {
  const p = make({ ttlMs: 200 });
  const first = await p.current();
  await vi.waitFor(() => expect(events.filter((e) => e.kind === 'code').length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
  const second = (events.filter((e) => e.kind === 'code')[1] as { pairing: { code: string } }).pairing;
  expect(second.code).toBe('ABCD-EFGH-JKMN');
  expect(second.code).not.toBe(first.code);
  expect(withdrawn[0]).toBe((await deriveCode('7K4Q9MXD2HTR')).lookup);
});

test('five failed attempts and the code is replaced', async () => {
  const p = make();
  await p.current();
  for (let i = 0; i < 4; i++) p.failed();
  expect(events.filter((e) => e.kind === 'code')).toHaveLength(1);
  p.failed();
  await vi.waitFor(() => expect(events.filter((e) => e.kind === 'code')).toHaveLength(2));
  expect((await p.current()).code).toBe('ABCD-EFGH-JKMN');
});

test('a phone asks: the request goes to the windows; Allow lets it in and the code dies with no renewal', async () => {
  const p = make();
  await p.current();
  const decision = p.ask({ name: 'Test iPhone', model: 'iPhone17,1' });
  const req = events.at(-1);
  expect(req).toMatchObject({ kind: 'request', request: { name: 'Test iPhone', model: 'iPhone17,1' } });
  // Single use: no other handshake may present the code meanwhile.
  expect(p.codes()).toEqual([]);
  const id = (req as { request: { id: string } }).request.id;
  expect(p.decide('another', true)).toBe(false);
  expect(p.decide(id, true)).toBe(true);
  expect(await decision).toBe('allow');
  p.finish();
  expect(withdrawn).toHaveLength(1);
  expect(p.codes()).toEqual([]);
  expect(events.filter((e) => e.kind === 'code')).toHaveLength(1);
});

test('Deny: declined, and a fresh code', async () => {
  const p = make();
  await p.current();
  const decision = p.ask({ name: 'X', model: 'm' });
  const id = (events.at(-1) as { request: { id: string } }).request.id;
  p.decide(id, false);
  expect(await decision).toBe('declined');
  await vi.waitFor(() => expect(events.filter((e) => e.kind === 'code')).toHaveLength(2));
  expect(events.some((e) => e.kind === 'denied' && e.reason === 'declined')).toBe(true);
});

test('no answer within the time: expired, and a fresh code; the phone leaving is the same', async () => {
  const p = make({ decideMs: 30 });
  await p.current();
  expect(await p.ask({ name: 'X', model: 'm' })).toBe('expired');
  expect(events.some((e) => e.kind === 'denied' && e.reason === 'expired')).toBe(true);
  await vi.waitFor(() => expect(events.filter((e) => e.kind === 'code')).toHaveLength(2));
  const again = p.ask({ name: 'Y', model: 'm' });
  p.cancel();
  expect(await again).toBe('expired');
});

test('a code that expires while a phone asks waits for the answer', async () => {
  const p = make({ ttlMs: 30, decideMs: 5000 });
  await p.current();
  const decision = p.ask({ name: 'X', model: 'm' });
  await new Promise((r) => setTimeout(r, 80));
  expect(events.filter((e) => e.kind === 'code')).toHaveLength(1);
  p.decide((events.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, true);
  expect(await decision).toBe('allow');
});

test('Allow spends the code at once, even when its time ran out meanwhile: never offered or presented again', async () => {
  const p = make({ ttlMs: 30, decideMs: 5000 });
  await p.current();
  const decision = p.ask({ name: 'X', model: 'm' });
  await new Promise((r) => setTimeout(r, 80));
  p.decide((events.find((e) => e.kind === 'request') as { request: { id: string } }).request.id, true);
  expect(await decision).toBe('allow');
  // Before the hub has added the phone (or found it gone): the code is no longer one to present.
  expect(p.codes()).toEqual([]);
  expect(withdrawn).toEqual([(await deriveCode('7K4Q9MXD2HTR')).lookup]);
  await new Promise((r) => setTimeout(r, 80));
  expect(events.filter((e) => e.kind === 'code')).toHaveLength(1);
});

test('allowed, but the phone was gone by then: the sheet hears it expired and gets a fresh code', async () => {
  const p = make();
  await p.current();
  const decision = p.ask({ name: 'X', model: 'm' });
  p.decide((events.at(-1) as { request: { id: string } }).request.id, true);
  expect(await decision).toBe('allow');
  p.lost();
  expect(events.at(-1)).toEqual({ kind: 'denied', reason: 'expired' });
  await vi.waitFor(() => expect(events.filter((e) => e.kind === 'code')).toHaveLength(2));
  expect(p.codes()).toEqual([{ lookup: (await deriveCode('ABCDEFGHJKMN')).lookup, psk: (await deriveCode('ABCDEFGHJKMN')).psk }]);
});

test('stopped: the code withdrawn, a pending request answered disabled, nothing renewed', async () => {
  const p = make({ ttlMs: 30 });
  await p.current();
  const decision = p.ask({ name: 'X', model: 'm' });
  p.stop();
  expect(await decision).toBe('disabled');
  expect(withdrawn).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 80));
  expect(events.filter((e) => e.kind === 'code')).toHaveLength(1);
  await expect(p.current()).rejects.toThrow();
});
