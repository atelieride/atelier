// Signs the update feed for CI: Ed25519 over the exact bytes of latest-mac.yml, base64 in latest-mac.yml.sig.
// The private key (PKCS8 PEM) comes only from the UPDATE_SIGNING_KEY environment variable and is never printed.
// Before writing, it checks the key is one whose public half is embedded in the app (UPDATE_PUBLIC_KEYS in
// src/shared/update-sign.node.ts): a wrong secret fails the job instead of shipping a feed nobody can install.
//
//   UPDATE_SIGNING_KEY="$(…)" node scripts/sign-feed.mjs release/latest-mac.yml [--public-key <raw base64>]
//
// --public-key replaces the embedded list with that one key: dry runs sign with a throwaway key made in the job.
// Node built-ins only: the workflow's publish job runs it without npm ci.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function privateKey(pem) {
  let key;
  // The parser's message could quote the input: replace it with our own.
  try { key = createPrivateKey({ key: pem, format: 'pem' }); } catch { throw new Error('UPDATE_SIGNING_KEY is not a PEM private key.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('UPDATE_SIGNING_KEY is not an Ed25519 key.');
  return key;
}

/** Raw public key (base64) of a PEM private key. */
export function publicKeyOf(pem) {
  return createPublicKey(privateKey(pem)).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length).toString('base64');
}

export function signFeed(bytes, pem) {
  return sign(null, bytes, privateKey(pem)).toString('base64');
}

/** Ed25519 check of a base64 signature (as written to latest-mac.yml.sig) against raw base64 public keys (any of them). */
export function verifyFeed(bytes, sigText, rawPublicKeys) {
  const keys = typeof rawPublicKeys === 'string' ? [rawPublicKeys] : rawPublicKeys;
  return keys.some((raw) => {
    try {
      const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw, 'base64')]), format: 'der', type: 'spki' });
      return verify(null, bytes, pub, Buffer.from(sigText.trim(), 'base64'));
    } catch { return false; }
  });
}

/** The UPDATE_PUBLIC_KEYS list of src/shared/update-sign.node.ts (its source text). */
export function embeddedKeysIn(source) {
  const block = /UPDATE_PUBLIC_KEYS[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  const keys = block ? [...block.matchAll(/'([A-Za-z0-9+/]{43}=)'/g)].map((m) => m[1]) : [];
  if (keys.length === 0) throw new Error('UPDATE_PUBLIC_KEYS not found in src/shared/update-sign.node.ts');
  return keys;
}

export function embeddedKeys() {
  return embeddedKeysIn(readFileSync(join(ROOT, 'src/shared/update-sign.node.ts'), 'utf8'));
}

/** Throws unless the private key's public half is in the list. Never prints the key. */
export function assertListedKey(pem, keys) {
  if (!keys.includes(publicKeyOf(pem))) throw new Error('UPDATE_SIGNING_KEY does not match a public key embedded in the app: nothing signed.');
}

function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) throw new Error('Usage: sign-feed.mjs <latest-mac.yml> [--public-key <raw base64>]');
  const pem = process.env.UPDATE_SIGNING_KEY;
  if (!pem) throw new Error('UPDATE_SIGNING_KEY is not set.');
  const i = process.argv.indexOf('--public-key');
  const keys = i > 0 ? [process.argv[i + 1]] : embeddedKeys();
  assertListedKey(pem, keys);
  const bytes = readFileSync(file);
  const sig = signFeed(bytes, pem);
  if (!verifyFeed(bytes, sig, keys)) throw new Error('The signature does not verify: nothing written.');
  writeFileSync(`${file}.sig`, `${sig}\n`);
  console.log(`Signed ${file} → ${file}.sig`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
