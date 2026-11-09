import { describe, expect, test } from 'vitest';
import { encodeCommand, RespError, RespParser, ReplyTooLarge, text } from './resp';

describe('encodeCommand', () => {
  test('arrays of bulk strings, byte lengths for UTF-8 and Buffers as they are', () => {
    expect(encodeCommand(['GET', 'città']).toString()).toBe('*2\r\n$3\r\nGET\r\n$6\r\ncittà\r\n');
    expect(encodeCommand(['SET', 'k', Buffer.from([0, 255]), 5]).equals(Buffer.concat([
      Buffer.from('*4\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\n'), Buffer.from([0, 255]), Buffer.from('\r\n$1\r\n5\r\n')
    ]))).toBe(true);
  });
});

describe('RespParser', () => {
  test('every RESP2 type', () => {
    const p = new RespParser();
    const out = p.push(Buffer.from('+OK\r\n-ERR bad\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*-1\r\n*2\r\n$1\r\na\r\n*1\r\n:-3\r\n'));
    expect(out[0]).toBe('OK');
    expect(out[1]).toBeInstanceOf(RespError);
    expect((out[1] as RespError).message).toBe('ERR bad');
    expect(out[2]).toBe(42);
    expect(text(out[3]!)).toBe('hello');
    expect(out[4]).toBeNull();
    expect(out[5]).toBeNull();
    expect(text((out[6] as unknown[])[0] as Buffer)).toBe('a');
    expect((out[6] as unknown[])[1]).toEqual([-3]);
  });

  test('frames split anywhere, byte by byte', () => {
    const wire = Buffer.from('*3\r\n$3\r\nfoo\r\n$0\r\n\r\n:7\r\n+PONG\r\n');
    const p = new RespParser();
    const got: unknown[] = [];
    for (const b of wire) got.push(...p.push(Buffer.from([b])));
    expect(got).toHaveLength(2);
    expect((got[0] as Buffer[]).map((x) => (Buffer.isBuffer(x) ? x.toString() : x))).toEqual(['foo', '', 7]);
    expect(got[1]).toBe('PONG');
  });

  test('a big bulk string in many small chunks, then the next reply in the same chunk', () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const wire = Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n+OK\r\n:5\r\n')]);
    const p = new RespParser();
    const got: unknown[] = [];
    for (let i = 0; i < wire.length; i += 4096) got.push(...p.push(wire.subarray(i, i + 4096)));
    expect(got).toHaveLength(3);
    expect((got[0] as Buffer).length).toBe(body.length);
    expect(got.slice(1)).toEqual(['OK', 5]);
  });

  test('bulk strings are binary-safe (CRLF inside is data)', () => {
    const p = new RespParser();
    const [v] = p.push(Buffer.from('$4\r\na\r\nb\r\n'));
    expect((v as Buffer).toString()).toBe('a\r\nb');
  });

  test('a reply over the cap throws ReplyTooLarge', () => {
    const p = new RespParser(10);
    expect(() => p.push(Buffer.from('$100\r\n'))).toThrow(ReplyTooLarge);
    const q = new RespParser(10);
    expect(() => q.push(Buffer.from('+' + 'x'.repeat(20)))).toThrow(ReplyTooLarge);
  });

  test('a protocol error (not RESP) throws', () => {
    expect(() => new RespParser().push(Buffer.from('HTTP/1.1 400 Bad Request\r\n'))).toThrow(/protocol/);
  });
});
