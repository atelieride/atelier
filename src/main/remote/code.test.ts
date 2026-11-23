import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CODE_ALPHABET, deriveCode, formatCode, newCode, normalizeCode, pairUrl, parsePairUrl } from './code';

describe('codes', () => {
  test('12 symbols of the Crockford alphabet, each one drawn from the CSPRNG', () => {
    const c = newCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    let i = 0;
    expect(newCode(() => (i++) % 32)).toBe('0123456789AB');
  });

  test('shown as three groups of four', () => {
    expect(formatCode('7K4Q9MXD2HTR')).toBe('7K4Q-9MXD-2HTR');
  });

  test('typed: upper-cased, spaces and dashes dropped, O, I and L read as 0, 1 and 1', () => {
    expect(normalizeCode(' 7k4q-9mxd-2htr ')).toBe('7K4Q9MXD2HTR');
    expect(normalizeCode('OIL0-1111-2222')).toBe('011011112222');
    expect(normalizeCode('7K4Q 9MXD 2HTR')).toBe('7K4Q9MXD2HTR');
  });

  test('anything else is not a code', () => {
    expect(normalizeCode('7K4Q-9MXD-2HTU')).toBeNull();
    expect(normalizeCode('7K4Q-9MXD-2HT')).toBeNull();
    expect(normalizeCode('7K4Q-9MXD-2HTRR')).toBeNull();
    expect(normalizeCode('7K4Q_9MXD_2HTR')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });
});

test('the lookup and the pre-shared key: PBKDF2-HMAC-SHA256, 100000 rounds, the two halves of 64 bytes', async () => {
  const dk = pbkdf2Sync('7K4Q9MXD2HTR', 'atelier-pair-v1', 100000, 64, 'sha256');
  const k = await deriveCode('7K4Q9MXD2HTR');
  expect(k.lookup).toBe(dk.subarray(0, 32).toString('base64url'));
  expect(k.lookup).toHaveLength(43);
  expect(k.psk.equals(dk.subarray(32))).toBe(true);
  await expect(deriveCode('7K4Q-9MXD-2HTR')).rejects.toThrow();
});

describe('the QR code URL', () => {
  const key = Buffer.alloc(32, 0xab);

  test('version, code, relay, host key and name, the free text percent-encoded', () => {
    expect(pairUrl({ code: '7K4Q9MXD2HTR', relay: 'http://127.0.0.1:8787', hostKey: key, name: 'Studio Mac & co' }))
      .toBe(`atelier://pair?v=1&c=7K4Q9MXD2HTR&r=http%3A%2F%2F127.0.0.1%3A8787&k=${key.toString('base64url')}&n=Studio%20Mac%20%26%20co`);
  });

  test('read back by the phone side; anything malformed is null', () => {
    const url = pairUrl({ code: '7K4Q9MXD2HTR', relay: 'https://relay.test', hostKey: key, name: 'Mac' });
    expect(parsePairUrl(url)).toEqual({ code: '7K4Q9MXD2HTR', relay: 'https://relay.test', hostKey: key, name: 'Mac' });
    expect(parsePairUrl(url.replace('v=1', 'v=2'))).toBeNull();
    expect(parsePairUrl(url.replace('atelier://', 'https://'))).toBeNull();
    expect(parsePairUrl(url.replace(/k=[^&]+/, 'k=AAAA'))).toBeNull();
    expect(parsePairUrl(url.replace(/c=[^&]+/, 'c=NOTACODE'))).toBeNull();
  });
});
