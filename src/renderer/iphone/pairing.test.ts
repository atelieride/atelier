import { expect, test } from 'vitest';
import type { RemoteDeviceInfo, RemotePairing, RemotePairRequest } from '@shared/remote';
import { PAIR_START, pairReducer, type PairAction, type PairSheet } from './pairing';

const code = (c: string, expiresAt = 1000): RemotePairing => ({ code: c, qr: `atelier://pair?v=1&c=${c.replace(/-/g, '')}`, expiresAt });
const request: RemotePairRequest = { id: 'r1', name: 'Test iPhone', model: 'iPhone17,1', expiresAt: 2000 };
const device: RemoteDeviceInfo = { id: 'd1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: 1, lastSeenAt: 1, connected: false, attached: [] };
const run = (...actions: PairAction[]): PairSheet => actions.reduce(pairReducer, PAIR_START);

test('started: the code, the offer to turn access on, or the reason it failed', () => {
  expect(run({ kind: 'started', result: { ok: true, pairing: code('AAAA-BBBB-CCCC') } })).toEqual({ phase: 'code', pairing: code('AAAA-BBBB-CCCC'), notice: null, waiting: false });
  expect(run({ kind: 'started', result: { ok: false, reason: 'disabled', message: 'Turn on access from iPhone first.' } })).toEqual({ phase: 'off' });
  expect(run({ kind: 'started', result: { ok: false, reason: 'unavailable', message: 'No relay.' } })).toEqual({ phase: 'error', message: 'No relay.' });
});

test('the code event that comes before startPairing\'s answer wins; a renewed code replaces the one on screen', () => {
  const first = run({ kind: 'code', pairing: code('NEW1-NEW1-NEW1') }, { kind: 'started', result: { ok: true, pairing: code('OLD0-OLD0-OLD0') } });
  expect(first).toMatchObject({ phase: 'code', pairing: { code: 'NEW1-NEW1-NEW1' } });
  expect(pairReducer(first, { kind: 'code', pairing: code('NEW2-NEW2-NEW2', 2000) })).toEqual({ phase: 'code', pairing: code('NEW2-NEW2-NEW2', 2000), notice: null, waiting: false });
});

test('a phone asks: the question, Allow on its way, then paired', () => {
  const asked = run({ kind: 'code', pairing: code('AAAA-BBBB-CCCC') }, { kind: 'request', request });
  expect(asked).toEqual({ phase: 'request', request, pairing: code('AAAA-BBBB-CCCC'), answering: false });
  const allowing = pairReducer(asked, { kind: 'allow' });
  expect(allowing).toMatchObject({ phase: 'request', answering: true });
  expect(pairReducer(allowing, { kind: 'paired', device })).toEqual({ phase: 'paired', name: 'Test iPhone' });
  // Nothing after it reopens the question.
  expect(pairReducer({ phase: 'paired', name: 'x' }, { kind: 'denied', reason: 'expired' })).toEqual({ phase: 'paired', name: 'x' });
  expect(pairReducer({ phase: 'paired', name: 'x' }, { kind: 'stopped' })).toEqual({ phase: 'paired', name: 'x' });
});

test('Deny, or no answer: the spent code stays dimmed until the fresh one, which keeps saying why', () => {
  const asked = run({ kind: 'code', pairing: code('AAAA-BBBB-CCCC') }, { kind: 'request', request });
  const denied = pairReducer(asked, { kind: 'denied', reason: 'declined' });
  expect(denied).toEqual({ phase: 'code', pairing: code('AAAA-BBBB-CCCC'), notice: 'declined', waiting: true });
  const fresh = pairReducer(denied, { kind: 'code', pairing: code('DDDD-EEEE-FFFF') });
  expect(fresh).toEqual({ phase: 'code', pairing: code('DDDD-EEEE-FFFF'), notice: 'declined', waiting: false });
  // The next renewal by itself has nothing to say.
  expect(pairReducer(fresh, { kind: 'code', pairing: code('GGGG-HHHH-JJJJ') })).toMatchObject({ notice: null });
  expect(pairReducer(asked, { kind: 'denied', reason: 'expired' })).toMatchObject({ notice: 'expired', waiting: true });
});

test('stopped elsewhere: the sheet asks for a code again; Allow outside a question does nothing', () => {
  expect(run({ kind: 'code', pairing: code('AAAA-BBBB-CCCC') }, { kind: 'stopped' })).toEqual({ phase: 'stopped' });
  expect(run({ kind: 'code', pairing: code('AAAA-BBBB-CCCC') }, { kind: 'allow' })).toMatchObject({ phase: 'code' });
  expect(run({ kind: 'started', result: { ok: false, reason: 'disabled', message: '' } }, { kind: 'start' })).toEqual(PAIR_START);
});
