import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SecretUnavailable, SecretUnreadable } from './errors';
import { createSecretStore, type SafeStorageLike } from './secret-store';
import { expectMode } from '../../../tests/support/platform';

// A stand-in for Electron's safeStorage (Keychain-backed in the app): reversible, recognizably not plaintext, and it
// refuses blobs it did not make, like the real decryptString does.
function fakeSafeStorage(o: { available?: boolean; failEncrypt?: boolean } = {}): SafeStorageLike & { encrypted: number } {
  const MAGIC = 'FAKE-SAFE:';
  return {
    encrypted: 0,
    isEncryptionAvailable: () => o.available ?? true,
    encryptString(plain: string) {
      if (o.failEncrypt) throw new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      this.encrypted++;
      return Buffer.from(MAGIC + Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
    },
    decryptString(blob: Buffer) {
      const s = blob.toString('utf8');
      if (!s.startsWith(MAGIC)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(s.slice(MAGIC.length).split('').reverse().join(''), 'base64').toString('utf8');
    }
  };
}

const tempHome = () => mkdtempSync(join(tmpdir(), 'atl-secret-'));
const SECRET = JSON.stringify({ token: 'fkat_secret-value-1234', clientId: 'fake-client-1' });

describe('secret store', () => {
  test('round trip: the value is stored encrypted in ATELIER_HOME/connectors/<id>.bin, 0600 in a 0700 folder', () => {
    const home = tempHome();
    const store = createSecretStore(home, fakeSafeStorage());
    expect(store.available()).toBe(true);
    expect(store.read('clickup')).toBeNull();
    store.write('clickup', SECRET);
    const file = join(home, 'connectors', 'clickup.bin');
    expect(store.path('clickup')).toBe(file);
    expect(existsSync(file)).toBe(true);
    expectMode(file, 0o600);
    expectMode(join(home, 'connectors'), 0o700);
    expect(readFileSync(file).toString('utf8')).not.toContain('fkat_secret-value-1234');
    expect(store.read('clickup')).toBe(SECRET);
  });

  test('atomic: an overwrite leaves no temporary file, and a failed write keeps the previous value intact', () => {
    const home = tempHome();
    createSecretStore(home, fakeSafeStorage()).write('clickup', 'v1');
    createSecretStore(home, fakeSafeStorage()).write('clickup', 'v2');
    expect(readdirSync(join(home, 'connectors'))).toEqual(['clickup.bin']);
    expect(() => createSecretStore(home, fakeSafeStorage({ failEncrypt: true })).write('clickup', 'v3')).toThrow();
    expect(readdirSync(join(home, 'connectors'))).toEqual(['clickup.bin']);
    expect(createSecretStore(home, fakeSafeStorage()).read('clickup')).toBe('v2');
  });

  test('Keychain unavailable: available() is false, write refuses with a typed error and writes nothing', () => {
    const home = tempHome();
    const store = createSecretStore(home, fakeSafeStorage({ available: false }));
    expect(store.available()).toBe(false);
    expect(() => store.write('clickup', SECRET)).toThrow(SecretUnavailable);
    expect(existsSync(join(home, 'connectors', 'clickup.bin'))).toBe(false);
  });

  test('Keychain unavailable with a stored blob: read throws SecretUnavailable (not plaintext, not null)', () => {
    const home = tempHome();
    createSecretStore(home, fakeSafeStorage()).write('clickup', SECRET);
    expect(() => createSecretStore(home, fakeSafeStorage({ available: false })).read('clickup')).toThrow(SecretUnavailable);
  });

  test('a garbled blob → SecretUnreadable, whose message carries neither the blob nor the value', () => {
    const home = tempHome();
    const store = createSecretStore(home, fakeSafeStorage());
    store.write('clickup', SECRET);
    writeFileSync(join(home, 'connectors', 'clickup.bin'), 'garbage fkat_secret-value-1234');
    let error: unknown;
    try { store.read('clickup'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SecretUnreadable);
    expect(String((error as Error).message)).not.toContain('fkat_');
    expect((error as Error).cause).toBeUndefined();
  });

  test('has: whether a value is stored, without decrypting it; false while the Keychain is unavailable', () => {
    const home = tempHome();
    const safe = fakeSafeStorage();
    let decrypts = 0;
    const counting: SafeStorageLike = { ...safe, isEncryptionAvailable: () => safe.isEncryptionAvailable(), encryptString: (v) => safe.encryptString(v), decryptString: (b) => { decrypts++; return safe.decryptString(b); } };
    const store = createSecretStore(home, counting);
    expect(store.has('db-c0123456789ab')).toBe(false);
    store.write('db-c0123456789ab', 'pw');
    expect(store.has('db-c0123456789ab')).toBe(true);
    expect(decrypts).toBe(0);
    // A garbled blob still "is there" (read says it can't be read).
    writeFileSync(join(home, 'connectors', 'notion.bin'), 'garbage');
    expect(store.has('notion')).toBe(true);
    expect(createSecretStore(home, fakeSafeStorage({ available: false })).has('db-c0123456789ab')).toBe(false);
    expect(() => store.has('../x')).toThrow(TypeError);
  });

  test('remove deletes the blob; removing a missing one is fine', () => {
    const home = tempHome();
    const store = createSecretStore(home, fakeSafeStorage());
    store.write('clickup', SECRET);
    store.remove('clickup');
    expect(existsSync(join(home, 'connectors', 'clickup.bin'))).toBe(false);
    expect(store.read('clickup')).toBeNull();
    expect(() => store.remove('clickup')).not.toThrow();
  });

  test('connector ids are plain names: nothing can point the file outside the connectors folder', () => {
    const store = createSecretStore(tempHome(), fakeSafeStorage());
    for (const id of ['', '../clickup', 'a/b', 'ClickUp', 'clickup.bin', ' clickup', 'x'.repeat(40)]) {
      expect(() => store.write(id, 'v'), id).toThrow(TypeError);
      expect(() => store.read(id), id).toThrow(TypeError);
      expect(() => store.remove(id), id).toThrow(TypeError);
    }
  });
});
