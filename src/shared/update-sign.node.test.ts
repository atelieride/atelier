import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, test } from 'vitest';
import { UPDATE_PUBLIC_KEYS, rawPublicKey, verifyFeedSignature } from './update-sign.node';

// A throwaway key made here: the real private key exists only in CI and the maintainer's password manager.
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: rawPublicKey(publicKey) };
}
const yml = Buffer.from('version: 0.2.0\nchannel: stable\n');

test('a feed signed with the key verifies', () => {
  const k = testKey();
  const sig = sign(null, yml, k.privateKey).toString('base64');
  expect(verifyFeedSignature(yml, sig, k.raw)).toBe(true);
  // The .sig file ends with a newline.
  expect(verifyFeedSignature(yml, `${sig}\n`, k.raw)).toBe(true);
});

test('a tampered feed, a bad signature or another key never verify', () => {
  const k = testKey();
  const other = testKey();
  const sig = sign(null, yml, k.privateKey).toString('base64');
  expect(verifyFeedSignature(Buffer.from('version: 9.9.9\nchannel: stable\n'), sig, k.raw)).toBe(false);
  // One byte more (a trailing newline) is another document.
  expect(verifyFeedSignature(Buffer.concat([yml, Buffer.from('\n')]), sig, k.raw)).toBe(false);
  expect(verifyFeedSignature(yml, sig, other.raw)).toBe(false);
  expect(verifyFeedSignature(yml, sign(null, yml, other.privateKey).toString('base64'), k.raw)).toBe(false);
  expect(verifyFeedSignature(yml, '', k.raw)).toBe(false);
  expect(verifyFeedSignature(yml, 'not base64 at all', k.raw)).toBe(false);
  expect(verifyFeedSignature(yml, Buffer.alloc(64).toString('base64'), k.raw)).toBe(false);
  expect(verifyFeedSignature(yml, sig, 'short')).toBe(false);
});

test('the embedded public keys are valid raw Ed25519 keys', () => {
  expect(UPDATE_PUBLIC_KEYS.length).toBeGreaterThan(0);
  for (const k of UPDATE_PUBLIC_KEYS) expect(Buffer.from(k, 'base64')).toHaveLength(32);
  // Nothing signed with a test key verifies with it.
  const k = testKey();
  expect(verifyFeedSignature(yml, sign(null, yml, k.privateKey).toString('base64'))).toBe(false);
});
