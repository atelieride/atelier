// A stand-in for Electron's safeStorage, for unit tests and e2e (ATELIER_TEST_FAKE_SAFE_STORAGE=1, a devEnv variable:
// inert in the packaged app). e2e must never reach the real Keychain: an unpackaged Electron would create a Keychain
// item in the user's login keychain and may prompt. Reversible, recognizably not plaintext, and it refuses blobs it did
// not make, like the real decryptString.
import type { SafeStorageLike } from './secret-store';

const MAGIC = 'ATELIER-TEST-SAFE:';

export function testSafeStorage(o: { available?: boolean; failEncrypt?: boolean } = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => o.available ?? true,
    encryptString(plain: string) {
      if (o.failEncrypt) throw new Error('encryption failed');
      return Buffer.from(MAGIC + Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join(''), 'utf8');
    },
    decryptString(blob: Buffer) {
      const s = blob.toString('utf8');
      if (!s.startsWith(MAGIC)) throw new Error('decryption failed');
      return Buffer.from(s.slice(MAGIC.length).split('').reverse().join(''), 'base64').toString('utf8');
    }
  };
}
