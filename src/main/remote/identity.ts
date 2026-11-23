// This computer's identity for iPhone access: the room secret that proves to the relay it owns its room, and the
// static X25519 key paired phones pin. Made the first time remote access is used, kept encrypted through the secret
// store (safeStorage, Keychain-backed), never plaintext on disk. Resetting it unpairs every phone: a new room, a new key.
import { createHash, randomBytes } from 'node:crypto';
import type { SecretStore } from '../connectors/secret-store';
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from './noise';
import { b64url, fromB64url } from './wire';

export interface RemoteIdentity {
  roomSecret: Buffer;
  /** b64url(SHA-256("atelier-room-v1" ‖ roomSecret)): the room's public name at the relay. */
  roomId: string;
  host: KeyPair;
}

/** The secret store's entry (ATELIER_HOME/connectors/remote-identity.bin). */
export const IDENTITY_SECRET_ID = 'remote-identity';

export function roomIdOf(secret: Uint8Array): string {
  return b64url(createHash('sha256').update('atelier-room-v1', 'ascii').update(secret).digest());
}

export class IdentityUnreadable extends Error {
  constructor() { super('The stored identity for iPhone access is unreadable'); }
}

function decode(text: string): RemoteIdentity | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  const v = o as { v?: unknown; room?: unknown; key?: unknown } | null;
  if (!v || v.v !== 1 || typeof v.room !== 'string' || typeof v.key !== 'string') return null;
  const roomSecret = fromB64url(v.room, 32);
  const key = fromB64url(v.key, 32);
  if (!roomSecret || !key) return null;
  return { roomSecret, roomId: roomIdOf(roomSecret), host: keyPairFromPrivate(key) };
}

export class IdentityStore {
  constructor(private readonly secrets: Pick<SecretStore, 'available' | 'read' | 'write' | 'remove'>) {}

  /** Whether an identity can be kept here at all (encryption available). */
  available(): boolean { return this.secrets.available(); }

  /** The stored identity, null when none. Throws when one exists but can't be read. */
  load(): RemoteIdentity | null {
    const text = this.secrets.read(IDENTITY_SECRET_ID);
    if (text === null) return null;
    const id = decode(text);
    if (!id) throw new IdentityUnreadable();
    return id;
  }

  /** The stored identity, made and stored first when there is none. Throws without encryption. */
  ensure(): RemoteIdentity {
    const known = this.load();
    if (known) return known;
    const roomSecret = randomBytes(32);
    const host = generateKeyPair();
    this.secrets.write(IDENTITY_SECRET_ID, JSON.stringify({ v: 1, room: b64url(roomSecret), key: b64url(host.privateKey) }));
    return { roomSecret, roomId: roomIdOf(roomSecret), host };
  }

  reset(): void { this.secrets.remove(IDENTITY_SECRET_ID); }
}
