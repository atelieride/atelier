import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { expectMode } from '../../../tests/support/platform';
import { DeviceStore, MAX_DEVICES, deviceIdOf } from './devices';

const home = () => mkdtempSync(join(tmpdir(), 'atl-remote-dev-'));
const key = (n: number) => Buffer.alloc(32, n).toString('base64url');

test('paired devices live in ATELIER_HOME/remote/devices.json, 0600 in a 0700 folder', () => {
  const h = home();
  let now = 1000;
  const store = new DeviceStore(h, () => now);
  const d = store.add({ name: 'Test iPhone', model: 'iPhone17,1', key: key(1) });
  expect(d).toEqual({ id: deviceIdOf(key(1)), name: 'Test iPhone', model: 'iPhone17,1', key: key(1), pairedAt: 1000, lastSeenAt: 1000 });
  const file = join(h, 'remote', 'devices.json');
  expectMode(file, 0o600);
  expectMode(join(h, 'remote'), 0o700);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, devices: [d] });
  now = 5000;
  store.seen(d.id);
  expect(new DeviceStore(h).list()).toEqual([{ ...d, lastSeenAt: 5000 }]);
});

test('the allowlist is by key; pairing the same phone again keeps its id and takes its new name', () => {
  const store = new DeviceStore(home(), () => 1);
  const a = store.add({ name: 'Old name', model: 'iPhone16,2', key: key(1) });
  const b = store.add({ name: 'New name', model: 'iPhone16,2', key: key(1) });
  expect(b.id).toBe(a.id);
  expect(store.list()).toHaveLength(1);
  expect(store.byKey(key(1))?.name).toBe('New name');
  expect(store.byKey(key(2))).toBeNull();
});

test('removed one by one, or all at once', () => {
  const store = new DeviceStore(home(), () => 1);
  const a = store.add({ name: 'A', model: 'm', key: key(1) });
  store.add({ name: 'B', model: 'm', key: key(2) });
  expect(store.remove(a.id)).toBe(true);
  expect(store.remove(a.id)).toBe(false);
  expect(store.list().map((d) => d.name)).toEqual(['B']);
  store.clear();
  expect(store.list()).toEqual([]);
});

test('at most MAX_DEVICES: the one seen longest ago makes room', () => {
  let now = 0;
  const store = new DeviceStore(home(), () => ++now);
  for (let i = 1; i <= MAX_DEVICES; i++) store.add({ name: `D${i}`, model: 'm', key: key(i) });
  store.seen(store.byKey(key(1))!.id);
  store.add({ name: 'New', model: 'm', key: key(99) });
  expect(store.list()).toHaveLength(MAX_DEVICES);
  expect(store.byKey(key(2))).toBeNull();
  expect(store.byKey(key(1))).not.toBeNull();
});

test('an unreadable or foreign file reads as no devices (pair again), never a crash', () => {
  const h = home();
  mkdirSync(join(h, 'remote'), { recursive: true });
  writeFileSync(join(h, 'remote', 'devices.json'), '{not json');
  expect(new DeviceStore(h).list()).toEqual([]);
  writeFileSync(join(h, 'remote', 'devices.json'), JSON.stringify({ v: 1, devices: [{ id: 'x', name: 1 }] }));
  expect(new DeviceStore(h).list()).toEqual([]);
});
