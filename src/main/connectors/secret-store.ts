// Connector secrets: the token and the client registration, encrypted with Electron's safeStorage
// (Keychain-backed) into ATELIER_HOME/connectors/<id>.bin, 0600 in a 0700 folder, written atomically. Never plaintext on
// disk; the value never leaves the main process. safeStorage is injected (the app passes Electron's; tests a fake).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../../daemon/fsutil';
import { SecretUnavailable, SecretUnreadable } from './errors';

/** The part of Electron's `safeStorage` the store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStore {
  /** False when safeStorage can't encrypt (Keychain unavailable): Connect must refuse. */
  available(): boolean;
  /** The stored value; null when none. Throws SecretUnavailable / SecretUnreadable when one exists but can't be read. */
  read(id: string): string | null;
  /**
   * Whether a value is stored, without decrypting it: its blob is there and the Keychain can be asked. A
   * blob that can't be decrypted still counts (read() says so when it is needed).
   */
  has(id: string): boolean;
  /** Encrypts and stores atomically. Throws SecretUnavailable (nothing written) when encryption isn't available. */
  write(id: string, value: string): void;
  /** Deletes the blob (Disconnect). Missing: no-op. */
  remove(id: string): void;
  path(id: string): string;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;

export function createSecretStore(home: string, safe: SafeStorageLike): SecretStore {
  const dir = join(home, 'connectors');
  const fileOf = (id: string) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('invalid connector id');
    return join(dir, `${id}.bin`);
  };
  const available = () => {
    try { return safe.isEncryptionAvailable(); } catch { return false; }
  };
  return {
    available,
    path: fileOf,
    read(id) {
      const file = fileOf(id);
      if (!existsSync(file)) return null;
      if (!available()) throw new SecretUnavailable();
      let blob: Buffer;
      try { blob = readFileSync(file); } catch { throw new SecretUnreadable(id); }
      try { return safe.decryptString(blob); } catch { throw new SecretUnreadable(id); }
    },
    has(id) {
      return existsSync(fileOf(id)) && available();
    },
    write(id, value) {
      const file = fileOf(id);
      if (!available()) throw new SecretUnavailable();
      let blob: Buffer;
      // Encrypt first: a failure leaves the previous blob untouched (and the error carries nothing of the value).
      try { blob = safe.encryptString(value); } catch { throw new SecretUnavailable(); }
      ensureDir(dir, 0o700);
      writeFileAtomic(file, blob, 0o600);
    },
    remove(id) {
      rmSync(fileOf(id), { force: true });
    }
  };
}
