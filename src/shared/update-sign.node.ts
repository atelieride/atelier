// Signature of the update feed: Ed25519 over the exact bytes of latest-mac.yml, base64 in latest-mac.yml.sig.
// The public key is embedded in the app; the private key lives only in CI (UPDATE_SIGNING_KEY) and the maintainer's
// password manager. scripts/sign-feed.mjs makes the signature; this verifies it.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Raw Ed25519 public keys (base64) a release feed may be signed with: today one. To rotate, ship a release that adds
 * the successor key here (signed with the current one), wait until installs have it, then sign with the successor and
 * drop the old key in a later release. scripts/sign-feed.mjs refuses a key that is not in this list.
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  'O00N78E72zb7KRFTudY9NmqDfWm1V7l9L9MWHu65pTU='
];

// DER prefix of an Ed25519 SubjectPublicKeyInfo: the raw 32 bytes follow it.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SIG_B64 = /^[A-Za-z0-9+/]{86}==$/;

/** The raw key (base64) of a public KeyObject: what gets embedded. */
export function rawPublicKey(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64');
}

/** True when the signature verifies with one of the keys (the embedded list by default). */
export function verifyFeedSignature(yml: Buffer, sigText: string, publicKeys: string | readonly string[] = UPDATE_PUBLIC_KEYS): boolean {
  const sig = sigText.trim();
  if (!SIG_B64.test(sig)) return false;
  return (typeof publicKeys === 'string' ? [publicKeys] : publicKeys).some((k) => {
    const raw = Buffer.from(k, 'base64');
    if (raw.length !== 32) return false;
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
      return verify(null, yml, key, Buffer.from(sig, 'base64'));
    } catch {
      return false;
    }
  });
}
