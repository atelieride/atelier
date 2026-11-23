import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import { PushStore } from './push-store';

const home = () => mkdtempSync(join(tmpdir(), 'atl-remote-push-'));
const token = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const key = Buffer.alloc(32, 5);

test('each device\'s token, environment and push key, encrypted through the secret store, kept across restarts', () => {
  const h = home();
  const store = new PushStore(createSecretStore(h, testSafeStorage()));
  expect(store.list()).toEqual([]);
  store.set('dev1', { token: token(1), env: 'sandbox', key });
  store.set('dev2', { token: token(2), env: 'production', key: Buffer.alloc(32, 6) });
  // A newer registration of the same device replaces its earlier one (and comes last).
  store.set('dev1', { token: token(3), env: 'sandbox', key });
  const again = new PushStore(createSecretStore(h, testSafeStorage()));
  expect(again.list().map((r) => [r.device, r.token, r.env])).toEqual([['dev2', token(2), 'production'], ['dev1', token(3), 'sandbox']]);
  expect(again.list()[1]!.key.equals(key)).toBe(true);
  // Never plaintext on disk: neither the token nor the key.
  const blob = readFileSync(join(h, 'connectors', 'remote-push.bin'), 'utf8');
  expect(blob).not.toContain(token(3));
  expect(blob).not.toContain(key.toString('base64url'));
});

test('forgotten: a device unregistering or removed, a dead token, everything at a reset', () => {
  const store = new PushStore(createSecretStore(home(), testSafeStorage()));
  store.set('dev1', { token: token(1), env: 'sandbox', key });
  store.set('dev2', { token: token(2), env: 'sandbox', key });
  store.set('dev3', { token: token(3), env: 'sandbox', key });
  store.set('dev1', null);
  expect(store.forgetToken(token(9))).toBe(false);
  expect(store.forgetToken(token(2))).toBe(true);
  expect(store.list().map((r) => r.device)).toEqual(['dev3']);
  store.forgetDevice('dev3');
  expect(store.list()).toEqual([]);
  store.set('dev4', { token: token(4), env: 'sandbox', key });
  store.clear();
  expect(store.list()).toEqual([]);
});

test('a blob this version can\'t read is no registrations (the phones register again on their next connection)', () => {
  const h = home();
  const secrets = createSecretStore(h, testSafeStorage());
  secrets.write('remote-push', '{"v":9}');
  expect(new PushStore(secrets).list()).toEqual([]);
  writeFileSync(join(h, 'connectors', 'remote-push.bin'), 'garbage');
  expect(new PushStore(createSecretStore(h, testSafeStorage())).list()).toEqual([]);
});
