// A push notification's text, sealed for the one phone that registered the key: neither the relay nor Apple's push
// service can read it. AES-256-GCM with the phone's 32-byte push key, a random 12-byte nonce, and the key's id as
// associated data, so a payload can't be passed off under another key: p = b64url(nonce ‖ ciphertext ‖ tag).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const LABEL = 'atelier-push-v1';

/** b64url(SHA-256("atelier-push-v1" ‖ pushKey)[0..8]): how the phone finds the key a payload was sealed with. */
export function pushKeyId(key: Buffer): string {
  return createHash('sha256').update(LABEL, 'ascii').update(key).digest().subarray(0, 8).toString('base64url');
}

const aadOf = (key: Buffer) => Buffer.from(LABEL + pushKeyId(key), 'ascii');

export function sealPush(key: Buffer, plaintext: string, nonce: Buffer = randomBytes(12)): string {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aadOf(key));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64url');
}

/** What a phone does with `p` (tests): the plaintext, or a throw when it was altered or sealed with another key. */
export function openPush(key: Buffer, p: string): string {
  const bytes = Buffer.from(p, 'base64url');
  if (bytes.length < 12 + 16) throw new Error('too short');
  const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  d.setAAD(aadOf(key));
  d.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([d.update(bytes.subarray(12, bytes.length - 16)), d.final()]).toString('utf8');
}
