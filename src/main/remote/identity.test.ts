import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createSecretStore } from '../connectors/secret-store';
import { testSafeStorage } from '../connectors/test-safe-storage';
import { IdentityStore, roomIdOf } from './identity';
import { keyPairFromPrivate } from './noise';

const home = () => mkdtempSync(join(tmpdir(), 'atl-remote-id-'));

test('the room id: base64url of SHA-256 over "atelier-room-v1" and the secret, 43 characters', () => {
  const secret = Buffer.alloc(32, 9);
  const want = createHash('sha256').update('atelier-room-v1').update(secret).digest('base64url');
  expect(roomIdOf(secret)).toBe(want);
  expect(want).toHaveLength(43);
});

test('made once on first use, encrypted through the secret store, the same afterwards', () => {
  const h = home();
  const store = new IdentityStore(createSecretStore(h, testSafeStorage()));
  expect(store.load()).toBeNull();
  const a = store.ensure();
  expect(a.roomSecret).toHaveLength(32);
  expect(a.roomId).toBe(roomIdOf(a.roomSecret));
  expect(keyPairFromPrivate(a.host.privateKey).publicKey.equals(a.host.publicKey)).toBe(true);
  // Never plaintext on disk: the blob holds neither the secret nor the key.
  const blob = readFileSync(join(h, 'connectors', 'remote-identity.bin'), 'utf8');
  expect(blob).not.toContain(a.roomSecret.toString('base64url'));
  expect(blob).not.toContain(a.host.privateKey.toString('base64url'));
  const again = new IdentityStore(createSecretStore(h, testSafeStorage())).ensure();
  expect(again.roomId).toBe(a.roomId);
  expect(again.host.publicKey.equals(a.host.publicKey)).toBe(true);
});

test('reset removes it: the next one is a new room and a new key', () => {
  const h = home();
  const store = new IdentityStore(createSecretStore(h, testSafeStorage()));
  const a = store.ensure();
  store.reset();
  expect(existsSync(join(h, 'connectors', 'remote-identity.bin'))).toBe(false);
  const b = store.ensure();
  expect(b.roomId).not.toBe(a.roomId);
  expect(b.host.publicKey.equals(a.host.publicKey)).toBe(false);
});

test('without encryption there is no identity, and nothing is written', () => {
  const h = home();
  const store = new IdentityStore(createSecretStore(h, testSafeStorage({ available: false })));
  expect(store.available()).toBe(false);
  expect(() => store.ensure()).toThrow();
  expect(existsSync(join(h, 'connectors'))).toBe(false);
});

test('a stored value that is not an identity is unreadable, never replaced by itself', () => {
  const h = home();
  const secrets = createSecretStore(h, testSafeStorage());
  secrets.write('remote-identity', '{"v":1,"room":"short"}');
  const store = new IdentityStore(secrets);
  expect(() => store.ensure()).toThrow(/unreadable/i);
  expect(secrets.read('remote-identity')).toBe('{"v":1,"room":"short"}');
});
