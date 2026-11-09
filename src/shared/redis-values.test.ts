import { describe, expect, test } from 'vitest';
import { classifyString, decodeMsgpack, hexDump, unserializePhp } from './redis-values';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('PHP unserialize', () => {
  test('scalars, arrays as objects or lists, byte lengths with UTF-8', () => {
    expect(unserializePhp(bytes('i:42;'))).toBe(42);
    expect(unserializePhp(bytes('d:1.5;'))).toBe(1.5);
    expect(unserializePhp(bytes('b:1;'))).toBe(true);
    expect(unserializePhp(bytes('N;'))).toBeNull();
    expect(unserializePhp(bytes('s:6:"città";'))).toBe('città');
    expect(unserializePhp(bytes('a:2:{i:0;s:1:"a";i:1;s:1:"b";}'))).toEqual(['a', 'b']);
    expect(unserializePhp(bytes('a:2:{s:4:"name";s:3:"Mug";s:5:"price";i:1800;}'))).toEqual({ name: 'Mug', price: 1800 });
  });
  test('objects with private/protected props, enums, custom and references', () => {
    const o = 'O:8:"App\\\\User":2:{s:2:"id";i:7;s:11:"\0*\0password";s:3:"xyz";}'.replace('App\\\\User', 'App\\User');
    expect(unserializePhp(bytes(o))).toEqual({ __class: 'App\\User', id: 7, password: 'xyz' });
    expect(unserializePhp(bytes('E:13:"Status:Active";'))).toEqual({ __enum: 'Status:Active' });
    expect(unserializePhp(bytes('C:3:"Foo":5:{hello}'))).toEqual({ __class: 'Foo', __data: 'hello' });
    expect(unserializePhp(bytes('a:2:{i:0;i:1;i:1;r:2;}'))).toEqual([1, '[reference]']);
  });
  test('anything else is null (not PHP), including trailing bytes', () => {
    expect(unserializePhp(bytes('hello'))).toBeUndefined();
    expect(unserializePhp(bytes('s:5:"hi";'))).toBeUndefined();
    expect(unserializePhp(bytes('i:42;x'))).toBeUndefined();
  });
});

describe('msgpack', () => {
  test('maps, arrays, strings, numbers, nil, booleans, bin and ext', () => {
    // {"a":1,"b":[true,null,-1,"x"],"c":1.5}
    const m = Uint8Array.from([0x83, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0x94, 0xc3, 0xc0, 0xff, 0xa1, 0x78, 0xa1, 0x63, 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0]);
    expect(decodeMsgpack(m)).toEqual({ a: 1, b: [true, null, -1, 'x'], c: 1.5 });
    expect(decodeMsgpack(Uint8Array.from([0x91, 0xc4, 0x02, 0xde, 0xad]))).toEqual(['<bin 2 bytes: dead>']);
    expect(decodeMsgpack(Uint8Array.from([0x91, 0xd4, 0x01, 0x07]))).toEqual(['<ext 1: 07>']);
    expect(decodeMsgpack(Uint8Array.from([0x92, 0xcd, 0x01, 0x00, 0xd1, 0xff, 0x00]))).toEqual([256, -256]);
  });
  test('truncated or with trailing bytes: undefined', () => {
    expect(decodeMsgpack(Uint8Array.from([0x82, 0xa1, 0x61]))).toBeUndefined();
    expect(decodeMsgpack(Uint8Array.from([0x90, 0x00]))).toBeUndefined();
  });
});

describe('hexDump', () => {
  test('16 bytes a row with an ASCII column', () => {
    expect(hexDump(bytes('hello, world!\nbin\u0001'), 4096)).toEqual([
      '00000000  68 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21 0a 62 69  |hello, world!.bi|',
      '00000010  6e 01                                            |n.|'
    ]);
  });
});

describe('classifyString', () => {
  test('integer, JSON, PHP, text, msgpack, binary; JSON cut by the preview stays text', () => {
    expect(classifyString(bytes('17'), 2)).toMatchObject({ format: 'int', text: '17' });
    expect(classifyString(bytes('{"a":[1,2]}'), 11)).toMatchObject({ format: 'json', value: { a: [1, 2] } });
    expect(classifyString(bytes('a:1:{s:1:"k";i:1;}'), 18)).toMatchObject({ format: 'php', value: { k: 1 } });
    expect(classifyString(bytes('hello'), 5)).toMatchObject({ format: 'text', text: 'hello' });
    expect(classifyString(bytes('{"a":'), 900)).toMatchObject({ format: 'text' });
    expect(classifyString(Uint8Array.from([0x81, 0xa1, 0x6b, 0x01]), 4)).toMatchObject({ format: 'msgpack', value: { k: 1 } });
    const bin = classifyString(Uint8Array.from([0xff, 0xfe, 0x00, 0x01]), 4);
    expect(bin.format).toBe('binary');
    expect(bin.hex?.[0]).toContain('ff fe 00 01');
  });
});
