import { describe, expect, test } from 'vitest';
import { MAX_APP_MESSAGE, MAX_FRAGMENT, Reassembler, channelFrame, fragments, fromB64url, parseChannelFrame, prologue, protocolOf, b64url } from './wire';

describe('base64url', () => {
  test('without padding, both ways', () => {
    expect(b64url(Buffer.from([0xfb, 0xff]))).toBe('-_8');
    expect(fromB64url('-_8')?.equals(Buffer.from([0xfb, 0xff]))).toBe(true);
  });

  test('strict: other alphabets, padding and wrong lengths are refused', () => {
    expect(fromB64url('+/8=')).toBeNull();
    expect(fromB64url('a b')).toBeNull();
    expect(fromB64url('AAAA', 4)).toBeNull();
    expect(fromB64url(b64url(Buffer.alloc(32)), 32)).toHaveLength(32);
    // A string whose last symbol carries bits beyond the bytes is not a canonical encoding.
    expect(fromB64url('-_9')).toBeNull();
  });
});

test('the prologue: version, kind and id separated by NUL', () => {
  expect(prologue('pair', 'abc').toString('latin1')).toBe('atelier-remote-v1\0pair\0abc');
  expect(protocolOf('pair')).toBe('Noise_XXpsk3_25519_AESGCM_SHA256');
  expect(protocolOf('device')).toBe('Noise_XX_25519_AESGCM_SHA256');
});

describe('fragments', () => {
  test('a short message is one last fragment', () => {
    const f = fragments(Buffer.from('{"t":"ok","rid":1}'));
    expect(f).toHaveLength(1);
    expect(f[0]![0]).toBe(0);
    expect(f[0]!.subarray(1).toString()).toBe('{"t":"ok","rid":1}');
  });

  test('a long one is split at the largest fragment, every one flagged but the last, and reassembles', () => {
    const msg = Buffer.alloc(MAX_FRAGMENT * 2 + 5, 'x');
    const f = fragments(msg);
    expect(f.map((x) => [x[0], x.length - 1])).toEqual([[1, MAX_FRAGMENT], [1, MAX_FRAGMENT], [0, 5]]);
    expect(MAX_FRAGMENT).toBe(65535 - 16 - 1);
    const r = new Reassembler();
    expect(r.push(f[0]!)).toBeNull();
    expect(r.push(f[1]!)).toBeNull();
    expect(r.push(f[2]!)?.equals(msg)).toBe(true);
  });

  test('reassembly refuses a message beyond 8 MiB, an empty fragment and an unknown flag', () => {
    const r = new Reassembler();
    const part = Buffer.concat([Buffer.from([1]), Buffer.alloc(MAX_FRAGMENT)]);
    let threw = false;
    try { for (let i = 0; i * MAX_FRAGMENT <= MAX_APP_MESSAGE + MAX_FRAGMENT; i++) r.push(part); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(() => new Reassembler().push(Buffer.alloc(0))).toThrow();
    expect(() => new Reassembler().push(Buffer.from([2, 0x7b]))).toThrow();
    expect(() => fragments(Buffer.alloc(MAX_APP_MESSAGE + 1))).toThrow();
  });
});

describe('relay frames', () => {
  test('a 4-byte big-endian channel id, then the payload', () => {
    const f = channelFrame(0x01020304, Buffer.from('hi'));
    expect([...f.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect(parseChannelFrame(f)).toEqual({ ch: 0x01020304, payload: Buffer.from('hi') });
    expect(parseChannelFrame(channelFrame(4294967295, Buffer.alloc(0)))?.ch).toBe(4294967295);
    expect(parseChannelFrame(Buffer.from([0, 0, 1]))).toBeNull();
  });
});
