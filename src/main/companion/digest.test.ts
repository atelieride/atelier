import { appendFileSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { posixTest } from '../../../tests/support/platform';
import { chatEntries, pruneChat, renderChat, CHAT_CAP, type ChatEntry, type ChatState } from '@shared/companion/chat';
import { READ_CHUNK, readChat } from './digest';

// Counts the bytes readChat reads, to prove a later read takes only what was appended.
const io = vi.hoisted(() => ({ bytes: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (...a: Parameters<typeof real.open>) => {
    const fh = await real.open(...a);
    const read = fh.read.bind(fh) as (...r: unknown[]) => Promise<{ bytesRead: number }>;
    Object.assign(fh, { read: async (...r: unknown[]) => { const res = await read(...r); io.bytes += res.bytesRead; return res; } });
    return fh;
  };
  return { ...real, open, default: { ...real, open } };
});

const ROOT = '/p/app';
const FIXTURE = 'tests/fixtures/companion/session.jsonl';
const dir = () => mkdtempSync(join(tmpdir(), 'atl-digest-'));
const P = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-10-31T11:00:00.000Z', message: { role: 'user', content: text } });
const prompts = (entries: ChatEntry[]) => entries.filter((e): e is Extract<ChatEntry, { k: 'prompt' }> => e.k === 'prompt').map((e) => [e.n, e.text]);

describe('readChat', () => {
  it('reads a whole transcript into the same entries as line by line (less what chat.md can never show)', async () => {
    const st: ChatState = { prompts: 0, tools: {} };
    const expected = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).flatMap((l) => chatEntries(JSON.parse(l), ROOT, st));
    const c = await readChat(FIXTURE, null, ROOT);
    expect(c.entries).toEqual(pruneChat(expected));
    expect(renderChat(c.entries)).toBe(renderChat(expected));
    expect(c.state).toEqual(st);
    expect(c.offset).toBe(statSync(FIXTURE).size);
    expect(c.size).toBe(statSync(FIXTURE).size);
    expect(c.partial).toBe('');
  });

  it('a line still being written is kept as partial and parsed once complete: nothing lost, nothing half-parsed', async () => {
    const f = join(dir(), 's.jsonl');
    const third = P('three');
    writeFileSync(f, `${P('one')}\nnot json\n${P('two')}\n${third.slice(0, 20)}`);
    const c1 = await readChat(f, null, ROOT);
    expect(prompts(c1.entries)).toEqual([[1, 'one'], [2, 'two']]);
    expect(c1.partial).toBe(third.slice(0, 20));
    expect(c1.offset).toBe(statSync(f).size);
    appendFileSync(f, `${third.slice(20)}\n${P('four')}\n`);
    const c2 = await readChat(f, c1, ROOT);
    expect(prompts(c2.entries)).toEqual([[1, 'one'], [2, 'two'], [3, 'three'], [4, 'four']]);
    expect(c2.partial).toBe('');
    expect(c2.offset).toBe(statSync(f).size);
    // The cursor given is left as it was (a failed read keeps the caller's cache valid).
    expect(prompts(c1.entries)).toHaveLength(2);
    expect(c1.state.prompts).toBe(2);
  });

  it('a character cut by the writer is read whole next time', async () => {
    const f = join(dir(), 's.jsonl');
    const line = Buffer.from(`${P('caffè ☕ pronto')}\n`);
    const cut = line.indexOf(Buffer.from('☕')) + 1; // inside the 3-byte cup
    writeFileSync(f, line.subarray(0, cut));
    const c1 = await readChat(f, null, ROOT);
    expect(c1.offset).toBe(cut - 1);
    expect(c1.partial).toBe(line.subarray(0, cut - 1).toString('utf8'));
    appendFileSync(f, line.subarray(cut));
    const c2 = await readChat(f, c1, ROOT);
    expect(prompts(c2.entries)).toEqual([[1, 'caffè ☕ pronto']]);
  });

  it('a 20 MB transcript is read whole with every prompt; a later read takes only the appended bytes', async () => {
    const f = join(dir(), 'big.jsonl');
    const output = 'o'.repeat(9000);
    const parts: string[] = [];
    for (let i = 0; i < 2000; i++) {
      parts.push(P(`prompt ${i}`));
      parts.push(JSON.stringify({ type: 'assistant', timestamp: '2026-10-31T11:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }, { type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: `npm test -- ${i}` } }] } }));
      parts.push(JSON.stringify({ type: 'user', timestamp: '2026-10-31T11:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: output }] } }));
      // In the middle, lines longer than two read chunks (one chunk holds no newline at all): a pasted screenshot, a
      // pasted log (its prompt's "characters cut" count shows the whole line was read).
      if (i === 1000) {
        parts.push(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'with a screenshot' }, { type: 'image', source: { type: 'base64', data: 'A'.repeat(2 * READ_CHUNK + 1024) } }] } }));
        parts.push(P(`pasted log ${'x'.repeat(2 * READ_CHUNK + 1024)} END`));
      }
    }
    writeFileSync(f, parts.join('\n') + '\n');
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(20 * 1024 * 1024);
    io.bytes = 0;
    const c = await readChat(f, null, ROOT);
    expect(io.bytes).toBe(size);
    expect(c.offset).toBe(size);
    const st: ChatState = { prompts: 0, tools: {} };
    const all = parts.flatMap((l) => chatEntries(JSON.parse(l), ROOT, st));
    expect(c.entries).toEqual(pruneChat(all));
    const ps = prompts(c.entries);
    expect(ps).toHaveLength(2002);
    expect(ps.map(([n]) => n)).toEqual(Array.from({ length: 2002 }, (_, i) => i + 1));
    expect(ps[1001]).toEqual([1002, 'with a screenshot']);
    expect(String(ps[1002]![1]).startsWith('pasted log xxx')).toBe(true);
    expect(String(ps[1002]![1]).endsWith('xxx END')).toBe(true);
    expect(ps[2001]).toEqual([2002, 'prompt 1999']);
    expect(c.entries.some((e) => e.k === 'tool' && e.line === 'Bash npm test -- 1999')).toBe(true);
    const md = renderChat(c.entries);
    expect(md).toBe(renderChat(all));
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(CHAT_CAP);
    expect(md).toContain('YOU: prompt 0');
    expect(md).toContain('YOU: prompt 1999');

    const appended = `${P('one more')}\n`;
    appendFileSync(f, appended);
    io.bytes = 0;
    const c2 = await readChat(f, c, ROOT);
    expect(c2.offset - c.offset).toBe(Buffer.byteLength(appended));
    expect(io.bytes).toBe(Buffer.byteLength(appended));
    expect(prompts(c2.entries).at(-1)).toEqual([2003, 'one more']);
    // Nothing new: nothing read.
    io.bytes = 0;
    const c3 = await readChat(f, c2, ROOT);
    expect(io.bytes).toBe(0);
    expect(c3.entries).toEqual(c2.entries);
  });

  it('a character across two read chunks, mid-file, is read whole', async () => {
    const f = join(dir(), 's.jsonl');
    const first = `${P('before')}\n`;
    const head = `${first}{"type":"user","timestamp":"2026-10-31T11:00:00.000Z","message":{"role":"user","content":"start `;
    // The cup (3 bytes) starts one byte before the chunk boundary.
    const pad = READ_CHUNK - 1 - Buffer.byteLength(head);
    const line = `${head}${'x'.repeat(pad)}☕ end"}}\n${P('after')}\n`;
    expect(Buffer.from(line).indexOf(Buffer.from('☕'))).toBe(READ_CHUNK - 1);
    writeFileSync(f, line);
    const c = await readChat(f, null, ROOT);
    const ps = prompts(c.entries);
    expect(ps.map(([n]) => n)).toEqual([1, 2, 3]);
    expect(String(ps[1]![1]).endsWith('xxx☕ end')).toBe(true);
    expect(ps[2]).toEqual([3, 'after']);
  });

  it('a long session\'s cursor keeps every prompt and only about one chat.md of the rest, read at once or bit by bit', async () => {
    const f = join(dir(), 's.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      if (i % 300 === 0) lines.push(P(`prompt ${i}`));
      lines.push(JSON.stringify({ type: 'assistant', timestamp: '2026-10-31T11:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'r'.repeat(1000)}` }] } }));
    }
    writeFileSync(f, lines.slice(0, 2000).join('\n') + '\n');
    let c = await readChat(f, null, ROOT);
    const bound = Math.ceil(CHAT_CAP / 1000) + 1;
    expect(c.entries.filter((e) => e.k !== 'prompt').length).toBeLessThanOrEqual(bound);
    for (let from = 2000; from < lines.length; from += 250) {
      appendFileSync(f, lines.slice(from, from + 250).join('\n') + '\n');
      c = await readChat(f, c, ROOT);
      expect(c.entries.filter((e) => e.k !== 'prompt').length).toBeLessThanOrEqual(bound);
    }
    const st: ChatState = { prompts: 0, tools: {} };
    const all = lines.flatMap((l) => chatEntries(JSON.parse(l), ROOT, st));
    expect(prompts(c.entries)).toHaveLength(10);
    expect(renderChat(c.entries)).toBe(renderChat(all));
  });

  it('a file shorter than the cursor (truncated or replaced) is read again from the start', async () => {
    const f = join(dir(), 's.jsonl');
    writeFileSync(f, `${P('one')}\n${P('two')}\n${P('three')}\n`);
    const c1 = await readChat(f, null, ROOT);
    writeFileSync(f, `${P('fresh')}\n`);
    const c2 = await readChat(f, c1, ROOT);
    expect(prompts(c2.entries)).toEqual([[1, 'fresh']]);
    expect(c2.offset).toBe(statSync(f).size);
    expect(c2.state.prompts).toBe(1);
  });

  posixTest('a symlinked transcript is refused', async () => {
    const d = dir();
    writeFileSync(join(d, 'real.jsonl'), `${P('one')}\n`);
    symlinkSync(join(d, 'real.jsonl'), join(d, 'link.jsonl'));
    await expect(readChat(join(d, 'link.jsonl'), null, ROOT)).rejects.toThrow();
  });

  it('a missing file or a folder is refused', async () => {
    const d = dir();
    await expect(readChat(join(d, 'missing.jsonl'), null, ROOT)).rejects.toThrow();
    await expect(readChat(d, null, ROOT)).rejects.toThrow();
  });
});
