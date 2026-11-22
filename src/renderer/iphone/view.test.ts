import { expect, test } from 'vitest';
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { connectedDevices, countdown, deviceSubtitle, deviceTitle, modelName, phoneTerminals, pillView, relayLine, relayProblem, seenText } from './view';

const device = (o: Partial<RemoteDeviceInfo> = {}): RemoteDeviceInfo => ({ id: 'd1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: 1000, lastSeenAt: 1000, connected: false, attached: [], ...o });
const status = (o: Partial<RemoteStatus> = {}): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });

test('a phone by its marketing name, its family when the model is newer than the list', () => {
  expect(modelName('iPhone17,1')).toBe('iPhone 16 Pro');
  expect(modelName('iPhone18,4')).toBe('iPhone Air');
  expect(modelName('iPhone99,1')).toBe('iPhone');
  expect(modelName('iPad16,3')).toBe('iPad');
  expect(modelName('arm64')).toBe('arm64');
  expect(modelName('')).toBe('iPhone');
});

test('a phone is called by its own name, or by its model when iOS only says "iPhone"', () => {
  expect(deviceTitle({ name: 'Test iPhone', model: 'iPhone17,1' })).toBe('Test iPhone');
  expect(deviceSubtitle({ name: 'Test iPhone', model: 'iPhone17,1' })).toBe('iPhone 16 Pro');
  expect(deviceTitle({ name: 'iPhone', model: 'iPhone17,1' })).toBe('iPhone 16 Pro');
  expect(deviceTitle({ name: '  ', model: 'iPhone15,4' })).toBe('iPhone 15');
  // The title is the model already: no second line saying it again.
  expect(deviceSubtitle({ name: 'iPhone', model: 'iPhone17,1' })).toBeNull();
});

test('the relay line: each state in words, the main process\'s message for an error, nothing while off', () => {
  expect(relayLine(null)).toBeNull();
  expect(relayLine(status({ enabled: false, relay: { state: 'offline' } }))).toBeNull();
  expect(relayLine(status())).toEqual({ tone: 'ok', text: 'Connected to the relay' });
  expect(relayLine(status({ relay: { state: 'connecting' } }))?.tone).toBe('busy');
  expect(relayLine(status({ relay: { state: 'offline' } }))).toEqual({ tone: 'warn', text: "Can't reach the relay. Atelier keeps trying." });
  expect(relayLine(status({ relay: { state: 'error', message: 'The relay refused this computer\'s identity.' } }))).toEqual({ tone: 'err', text: 'The relay refused this computer\'s identity.' });
  expect(relayLine(status({ relay: { state: 'error' } }))?.text).toBe("Atelier can't use the relay.");
  // No encryption: said even while off (Settings explains why the toggle can't help).
  expect(relayLine(status({ enabled: false, available: false }))?.tone).toBe('err');
});

test('connected now, or when it was last seen', () => {
  const now = 10 * 60_000;
  expect(seenText(device({ connected: true }), now)).toBe('Connected');
  expect(seenText(device({ lastSeenAt: now - 2 * 60_000 }), now)).toBe('Last seen 2 min ago');
});

test('countdowns: minutes and seconds left, rounded up, never below zero', () => {
  expect(countdown(300_000)).toBe('5:00');
  expect(countdown(299_001)).toBe('5:00');
  expect(countdown(298_999)).toBe('4:59');
  expect(countdown(59_400)).toBe('1:00');
  expect(countdown(9_000)).toBe('0:09');
  expect(countdown(0)).toBe('0:00');
  expect(countdown(-5_000)).toBe('0:00');
});

test('the relay field says what is wrong with an address, nothing for one Atelier can dial', () => {
  for (const ok of ['https://relay.useatelier.dev', 'http://localhost:8787', 'http://192.168.1.20:8787', ' https://relay.test ']) expect(relayProblem(ok), ok).toBeNull();
  expect(relayProblem('')).toMatch(/Type the address/);
  expect(relayProblem('relay.test')).toMatch(/https:\/\//);
  expect(relayProblem('ws://localhost:8787')).toMatch(/starts with https/);
  expect(relayProblem('http://relay.test')).toMatch(/only for this computer or your local network/);
  expect(relayProblem('http://8.8.8.8:8787')).toMatch(/only for this computer/);
  expect(relayProblem('https://me:secret@relay.test')).toMatch(/Leave out/);
  expect(relayProblem('https://relay.test/?a=1')).toMatch(/Leave out/);
  expect(relayProblem('https://')).not.toBeNull();
});

test('the connected phones, the terminals they have open, the pill naming them', () => {
  const a = device({ id: 'a', connected: true, attached: ['t1', 't2'] });
  const b = device({ id: 'b', name: 'iPhone', model: 'iPhone15,4', connected: true, attached: ['t2'] });
  const gone = device({ id: 'c', connected: false, attached: ['t3'] });
  const s = status({ devices: [a, b, gone] });
  expect(connectedDevices(s).map((d) => d.id)).toEqual(['a', 'b']);
  expect(phoneTerminals(s).sort()).toEqual(['t1', 't2']);
  // Access turned off: nobody is connected, whatever the last list said.
  expect(connectedDevices(status({ enabled: false, devices: [a] }))).toEqual([]);
  expect(pillView([])).toBeNull();
  expect(pillView([a])).toEqual({ label: 'iPhone', tip: 'Connected now: Test iPhone' });
  expect(pillView([a, b])).toEqual({ label: '2 iPhones', tip: 'Connected now: Test iPhone, iPhone 15' });
});
