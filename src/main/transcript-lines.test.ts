import { mkdtemp, rm, writeFile, appendFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_CHUNK, readJsonLines } from './transcript-lines';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tl-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('readJsonLines', () => {
  it('every complete line once, in order; an unfinished one waits for its newline', async () => {
    const f = join(dir, 't.jsonl');
    await writeFile(f, '{"n":1}\n{"n":2}\n{"n":');
    const seen: unknown[] = [];
    const c1 = await readJsonLines(f, null, (l) => seen.push(l));
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(c1.partial).toBe('{"n":');
    await appendFile(f, '3}\n');
    const c2 = await readJsonLines(f, c1, (l) => seen.push(l));
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(c2.partial).toBe('');
    expect(c2.fromStart).toBe(false);
  });

  it('a character cut by the writer is read whole next time', async () => {
    const f = join(dir, 't.jsonl');
    const bytes = Buffer.from('{"t":"☕"}\n');
    const cut = bytes.indexOf(Buffer.from('☕')) + 1;
    await writeFile(f, bytes.subarray(0, cut));
    const seen: unknown[] = [];
    const c1 = await readJsonLines(f, null, (l) => seen.push(l));
    expect(seen).toEqual([]);
    await appendFile(f, bytes.subarray(cut));
    await readJsonLines(f, c1, (l) => seen.push(l));
    expect(seen).toEqual([{ t: '☕' }]);
  });

  it('a file shorter than the cursor is read from the start, and the caller hears of it before the first line', async () => {
    const f = join(dir, 't.jsonl');
    await writeFile(f, '{"n":1}\n{"n":2}\n');
    const c1 = await readJsonLines(f, null, () => {});
    await writeFile(f, '{"n":9}\n');
    const order: string[] = [];
    const c2 = await readJsonLines(f, c1, () => order.push('line'), undefined, (s) => order.push(s ? 'start' : 'resume'));
    expect(c2.fromStart).toBe(true);
    expect(order).toEqual(['start', 'line']);
  });

  it('a normal resume tells onStart(false) before its lines', async () => {
    const f = join(dir, 't.jsonl');
    await writeFile(f, '{"n":1}\n');
    const c1 = await readJsonLines(f, null, () => {});
    await appendFile(f, '{"n":2}\n');
    const order: string[] = [];
    await readJsonLines(f, c1, () => order.push('line'), undefined, (s) => order.push(s ? 'start' : 'resume'));
    expect(order).toEqual(['resume', 'line']);
  });

  it('onChunk runs once per chunk with lines, and not for a read without a complete line', async () => {
    const f = join(dir, 't.jsonl');
    const line = JSON.stringify({ pad: 'x'.repeat(1000) }) + '\n';
    await writeFile(f, line.repeat(Math.ceil((READ_CHUNK * 1.5) / line.length)));
    let chunks = 0;
    await readJsonLines(f, null, () => {}, () => { chunks++; });
    expect(chunks).toBe(2);
    const g = join(dir, 'u.jsonl');
    await writeFile(g, '{"n":');
    chunks = 0;
    await readJsonLines(g, null, () => {}, () => { chunks++; });
    expect(chunks).toBe(0);
  });

  it('a symlink or a folder is refused', async () => {
    const f = join(dir, 't.jsonl');
    await writeFile(f, '{}\n');
    await symlink(f, join(dir, 'link.jsonl'));
    await mkdir(join(dir, 'sub'));
    await expect(readJsonLines(join(dir, 'link.jsonl'), null, () => {})).rejects.toThrow();
    await expect(readJsonLines(join(dir, 'sub'), null, () => {})).rejects.toThrow();
  });
});
