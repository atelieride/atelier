import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SEARCH_LIMITS } from '@shared/search';
import { compileSearch } from '@shared/search-match';
import { scanFile, type ScanLimits } from './scan';

const notWindows = process.platform !== 'win32';
const small: ScanLimits = { wholeReadBytes: 64, maxBytes: 1024, keptLineChars: 2000 };
const roomy: ScanLimits = { wholeReadBytes: 10_000_000, maxBytes: 20_000_000, keptLineChars: 2000 };
const streaming: ScanLimits = { wholeReadBytes: 64, maxBytes: 20_000_000, keptLineChars: 2000 };
const never = () => false;

function ranges(query: string): (line: string) => [number, number][] {
  const c = compileSearch({ query, matchCase: true, wholeWord: false, regex: false });
  if (c.kind !== 'ok') throw new Error('bad query');
  return c.ranges;
}

let root = '';
function dir(): string {
  if (!root) root = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scan-')));
  return root;
}
let n = 0;
function put(body: string | Buffer, name = `f${n++}.txt`): string {
  const p = join(dir(), name);
  writeFileSync(p, body);
  return p;
}
const scan = (p: string, q = 'token', limits = small, budget = 1000, cancelled = never) =>
  scanFile(p, ranges(q), limits, budget, cancelled, dir());

function lines(r: Awaited<ReturnType<typeof scan>>) {
  if (r.kind !== 'lines') throw new Error(`lines expected, got ${r.kind}`);
  return r;
}

describe('scanFile', () => {
  test('matches with 1-based lines and UTF-16 columns', async () => {
    const r = lines(await scan(put('one\nxx token yy\n😀 token\n')));
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.lines.map((l) => [l.line, l.ranges])).toEqual([[2, [[3, 8]]], [3, [[3, 8]]]]);
  });

  test('CRLF lines carry no carriage return', async () => {
    const r = lines(await scan(put('a token\r\nb token\r\n')));
    expect(r.lines.map((l) => l.text)).toEqual(['a token', 'b token']);
    expect(r.lines[0]!.ranges).toEqual([[2, 7]]);
  });

  test('a NUL in the first 8 KB is binary', async () => {
    expect(await scan(put(Buffer.from('token\0token')))).toEqual({ kind: 'binary' });
  });

  test('UTF-16 LE with a BOM is decoded', async () => {
    const r = lines(await scan(put(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a token\n', 'utf16le')]))));
    expect(r.lines[0]!.ranges).toEqual([[2, 7]]);
  });

  test('not-UTF-8 bytes are decoded as Latin-1', async () => {
    const r = lines(await scan(put(Buffer.from('caf\xe9 token\n', 'latin1'))));
    expect(r.lines[0]!.text).toBe('café token');
    expect(r.lines[0]!.ranges).toEqual([[5, 10]]);
  });

  test('a streamed read gives the same result as a whole read', async () => {
    const body = Array.from({ length: 30_000 }, (_, i) => (i % 7 === 0 ? `é😀 token ${i}\r` : `ünï ${i}`)).join('\n') + '\n';
    const p = put(body);
    const whole = await scan(p, 'token', roomy, 1e6);
    expect(await scan(p, 'token', streaming, 1e6)).toEqual(whole);
    expect(lines(whole).count).toBeGreaterThan(4000);
  });

  test('a streamed read decodes Latin-1 and UTF-16 files like a whole read', async () => {
    const lat = put(Buffer.from('caf\xe9 token\n'.repeat(20_000), 'latin1'));
    const wide = put(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('é token\n'.repeat(20_000), 'utf16le')]));
    for (const p of [lat, wide]) {
      const whole = await scan(p, 'token', roomy, 1e6);
      expect(await scan(p, 'token', streaming, 1e6)).toEqual(whole);
      expect(lines(whole).count).toBe(20_000);
    }
  });

  test('a file over maxBytes is skipped with its size', async () => {
    expect(await scan(put('token '.repeat(400)))).toEqual({ kind: 'skipped', size: 2400, reason: 'too-large' });
  });

  test('the budget stops the file and says so', async () => {
    const r = lines(await scan(put('token\n'.repeat(5)), 'token', roomy, 2));
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBe(2);
    const exact = lines(await scan(put('token\n'.repeat(2)), 'token', roomy, 2));
    expect(exact.truncated).toBe(false);
  });

  test('a budget inside one line keeps only that many ranges', async () => {
    const r = lines(await scan(put('token token token\n'), 'token', roomy, 2));
    expect(r.count).toBe(2);
    expect(r.lines[0]!.ranges.length).toBe(2);
    expect(r.truncated).toBe(true);
  });

  test('a deleted path is none', async () => {
    expect(await scan(join(dir(), 'nope.txt'))).toEqual({ kind: 'none' });
  });

  test.skipIf(!notWindows || process.getuid?.() === 0)('an unreadable file is skipped as unreadable', async () => {
    const p = put('token\n');
    chmodSync(p, 0);
    try {
      expect(await scan(p)).toEqual({ kind: 'skipped', size: 6, reason: 'unreadable' });
    } finally {
      chmodSync(p, 0o644);
    }
  });

  test('one 3 MB line with 5,000 matches keeps 2,000 chars and every range', async () => {
    const p = put('token' + ' '.repeat(600) + `${'token '.repeat(4999)}${'x'.repeat(3_000_000)}\n`);
    const r = lines(await scan(p, 'token', { ...SEARCH_LIMITS }, 20_000));
    expect(r.lines.length).toBe(1);
    expect(r.lines[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(r.lines[0]!.ranges.length).toBe(5000);
    expect(r.count).toBe(5000);
  });

  test('cancelling mid-stream stops early', async () => {
    const p = put('token\n'.repeat(400_000));
    let calls = 0;
    const r = await scan(p, 'token', streaming, 1_000_000, () => ++calls > 2);
    expect(r).toEqual({ kind: 'none' });
    expect(calls).toBeLessThan(10);
  });

  test.skipIf(!notWindows)('a link to a file outside the root is none', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'atl-scan-out-')));
    writeFileSync(join(outside, 'o.txt'), 'token\n');
    const link = join(dir(), 'outlink.txt');
    symlinkSync(join(outside, 'o.txt'), link);
    expect(await scan(link)).toEqual({ kind: 'none' });
  });

  test.skipIf(!notWindows)('a link to a file inside the root is read', async () => {
    const link = join(dir(), 'inlink.txt');
    symlinkSync(put('token\n'), link);
    expect(lines(await scan(link)).count).toBe(1);
  });

  test('a path under .git is none', async () => {
    mkdirSync(join(dir(), '.git'), { recursive: true });
    const p = join(dir(), '.git', 'config');
    writeFileSync(p, 'token\n');
    expect(await scan(p)).toEqual({ kind: 'none' });
  });

  test('a binary file over maxBytes is binary, not too large', async () => {
    expect(await scan(put(Buffer.concat([Buffer.from('PK\0\0'), Buffer.alloc(5000, 1)])))).toEqual({ kind: 'binary' });
  });

  test('one 2 MB line is streamed without quadratic work', async () => {
    const p = put(`${'x'.repeat(1_000_000)} token ${'y'.repeat(1_000_000)}\n`);
    const t0 = Date.now();
    const r = lines(await scan(p, 'token', { wholeReadBytes: 64, maxBytes: 20_000_000, keptLineChars: 2000, chunkBytes: 4096 }));
    expect(r.lines[0]!.ranges).toEqual([[1_000_001, 1_000_006]]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('every chunk boundary is safe: multibyte, CRLF, UTF-16 LE and BE, no final newline', async () => {
    const text = 'é😀 token\r\nü token 日本\r\nlast token';
    const files = [
      put(text),
      put(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])),
      put(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()])),
      put(Buffer.from('caf\xe9 token\r\nx token', 'latin1')),
    ];
    for (const p of files) {
      const whole = lines(await scan(p, 'token', roomy));
      expect(whole.count).toBe(whole.lines.length);
      expect(whole.lines.length).toBeGreaterThanOrEqual(2);
      for (const chunkBytes of [1, 2, 3, 5]) {
        expect(await scan(p, 'token', { wholeReadBytes: 1, maxBytes: 1e6, keptLineChars: 2000, chunkBytes })).toEqual(whole);
      }
    }
    const last = lines(await scan(files[0]!, 'token', roomy));
    expect(last.lines.map((l) => l.text)).toEqual(['é😀 token', 'ü token 日本', 'last token']);
  });

  test('UTF-16 with an odd trailing byte drops it, whole and streamed', async () => {
    const p = put(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a token\nb token', 'utf16le'), Buffer.from([0x41])]));
    const whole = lines(await scan(p, 'token', roomy));
    expect(whole.lines[1]!.text).toBe('b token');
    expect(await scan(p, 'token', { wholeReadBytes: 1, maxBytes: 1e6, keptLineChars: 2000, chunkBytes: 4 })).toEqual(whole);
  });

  test('Latin-1 restart after matches were collected keeps nothing from the first attempt', async () => {
    const p = put(Buffer.concat([Buffer.from('token\n'.repeat(60_000)), Buffer.from('caf\xe9 token\n', 'latin1')]));
    const whole = lines(await scan(p, 'token', roomy, 1e6));
    const streamed = lines(await scan(p, 'token', streaming, 1e6));
    expect(streamed).toEqual(whole);
    expect(streamed.count).toBe(60_001);
  });

  test('the budget truncates a streamed file too', async () => {
    const r = lines(await scan(put('token\n'.repeat(50_000)), 'token', streaming, 3));
    expect(r.count).toBe(3);
    expect(r.truncated).toBe(true);
  });

  test('a directory is none', async () => {
    const d = join(dir(), 'adir');
    mkdirSync(d, { recursive: true });
    expect(await scan(d)).toEqual({ kind: 'none' });
  });
});
