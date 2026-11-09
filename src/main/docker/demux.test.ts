import { describe, expect, test } from 'vitest';
import { Demuxer, LineSplitter, MAX_LINE } from './demux';

const frame = (stream: 1 | 2, text: string) => {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('Demuxer: the multiplexed log stream (no TTY)', () => {
  test('frames of both streams in one chunk', () => {
    const d = new Demuxer();
    expect(d.push(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')])).map((f) => [f.err, f.data.toString()])).toEqual([[false, 'out\n'], [true, 'err\n']]);
  });
  test('a header and a body split across chunks, byte by byte', () => {
    const d = new Demuxer();
    const all = Buffer.concat([frame(1, 'héllo\n'), frame(2, 'x')]);
    const out: string[] = [];
    for (let i = 0; i < all.length; i++) for (const f of d.push(all.subarray(i, i + 1))) out.push(`${f.err ? 'E' : 'O'}:${f.data.toString('latin1')}`);
    expect(Buffer.from(out.filter((s) => s.startsWith('O')).map((s) => s.slice(2)).join(''), 'latin1').toString('utf8')).toBe('héllo\n');
    expect(out.filter((s) => s.startsWith('E')).map((s) => s.slice(2)).join('')).toBe('x');
  });
  test('stdin frames (0) and empty frames are skipped', () => {
    const d = new Demuxer();
    expect(d.push(Buffer.concat([frame(1, ''), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 65])]))).toEqual([]);
  });
  test('a declared size beyond the cap is clamped: the stream cannot make it buffer gigabytes', () => {
    const d = new Demuxer();
    const head = Buffer.alloc(8); head[0] = 1; head.writeUInt32BE(0xffffffff, 4);
    expect(() => d.push(Buffer.concat([head, Buffer.from('abc')]))).not.toThrow();
    expect(d.buffered()).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('LineSplitter', () => {
  test('lines across chunks, \\r\\n, a multi-byte character split in two', () => {
    const s = new LineSplitter();
    const bytes = Buffer.from('a\r\nbé', 'utf8');
    expect(s.push(bytes.subarray(0, 5))).toEqual(['a']);
    expect(s.push(Buffer.concat([bytes.subarray(5), Buffer.from('\nc')]))).toEqual(['bé']);
    expect(s.flush()).toEqual(['c']);
    expect(s.flush()).toEqual([]);
  });
  test('a \\r rewrite (progress bars) keeps the last version of the line', () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from('10%\r50%\r100%\n'))).toEqual(['100%']);
  });
  test('…and keeps Docker\'s timestamp, which only the first version carries', () => {
    const s = new LineSplitter();
    expect(s.push(Buffer.from('2026-10-15T07:41:02.118123456Z 10%\r50%\r100%\n'))).toEqual(['2026-10-15T07:41:02.118123456Z 100%']);
  });
  test('a line longer than the cap is cut with an ellipsis, the rest of it dropped', () => {
    const s = new LineSplitter();
    const out = s.push(Buffer.from(`${'x'.repeat(MAX_LINE + 10)}\nnext\n`));
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBe(MAX_LINE + 1);
    expect(out[0]!.endsWith('…')).toBe(true);
    expect(out[1]).toBe('next');
  });
});
