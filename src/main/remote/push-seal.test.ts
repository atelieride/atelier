import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openPush, pushKeyId, sealPush } from './push-seal';

// The relay's own vectors, shared with the iOS app's notification extension.
const vectors = (JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/push-vectors.json'), 'utf8')) as { vectors: { pushKey: string; keyId: string; nonce: string; plaintext: string; p: string }[] }).vectors;

test('the key id and the sealed payload are the vectors\' to the byte', () => {
  expect(vectors.length).toBeGreaterThan(0);
  for (const v of vectors) {
    const key = Buffer.from(v.pushKey, 'base64url');
    expect(pushKeyId(key)).toBe(v.keyId);
    expect(sealPush(key, v.plaintext, Buffer.from(v.nonce, 'base64url'))).toBe(v.p);
    expect(openPush(key, v.p)).toBe(v.plaintext);
  }
});

test('a fresh nonce each time; altered, or opened with another key, it doesn\'t open', () => {
  const key = Buffer.alloc(32, 9);
  const a = sealPush(key, '{"v":1}');
  const b = sealPush(key, '{"v":1}');
  expect(a).not.toBe(b);
  expect(openPush(key, a)).toBe('{"v":1}');
  const bytes = Buffer.from(a, 'base64url');
  bytes[bytes.length - 1]! ^= 1;
  expect(() => openPush(key, bytes.toString('base64url'))).toThrow();
  expect(() => openPush(Buffer.alloc(32, 8), a)).toThrow();
});
