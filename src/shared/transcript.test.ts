import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TIMELINE_SHOWN, TranscriptReader, type ToolEntry } from './transcript';

const enc = (s: string) => new TextEncoder().encode(s);
const line = (o: object) => `${JSON.stringify(o)}\n`;
const T = '2026-10-12T21:33:10.000Z';
const user = (text: string) => line({ type: 'user', timestamp: T, message: { role: 'user', content: text } });
const toolUse = (id: string, name: string, input: object, extra: object = {}) =>
  line({ type: 'assistant', timestamp: T, message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5 } }, ...extra });
const toolResult = (id: string, content: string, isError = false, extra: object = {}) =>
  line({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra });

describe('TranscriptReader', () => {
  test('the task keeps its whole text and line breaks; a huge one is cut at the safety cap', () => {
    const body = Array.from({ length: 60 }, (_, i) => `${i + 1}. step ${'x'.repeat(40)}`).join('\n');
    const r = new TranscriptReader();
    r.push(enc(user(`  ${body}\n`)), '/p/repo');
    expect(body.length).toBeGreaterThan(2500);
    expect(r.meta.task).toBe(body);
    const big = new TranscriptReader();
    big.push(enc(user(`a\n${'y'.repeat(30000)}`)), '/p/repo');
    expect(big.meta.task!.length).toBe(20000);
    expect(big.meta.task!.endsWith('…')).toBe(true);
    expect(big.meta.task!.startsWith('a\ny')).toBe(true);
  });
  test('task, tools with targets and results, text, model, tokens, counters', () => {
    const r = new TranscriptReader();
    r.push(enc(
      user('Map every place that triggers a token refresh.')
      + toolUse('t1', 'Read', { file_path: '/p/repo/src/auth/session.ts' })
      + toolResult('t1', 'a\nb\nc')
      + toolUse('t2', 'Grep', { pattern: 'refreshToken', path: '/p/repo/src' })
      + toolResult('t2', 'boom: bad regex', true)
      + line({ type: 'assistant', timestamp: T, message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Two triggers so far.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    ), '/p/repo');
    expect(r.meta).toMatchObject({ task: 'Map every place that triggers a token refresh.', model: 'claude-haiku-5-5', tools: 2, files: 1 });
    expect(r.meta.tokens).toBe(125 + 125 + 15);
    const [read, grep, text] = r.entries;
    expect(read).toMatchObject({ kind: 'tool', tool: 'Read', target: 'src/auth/session.ts', result: 'ok', summary: '3 lines' });
    expect(grep).toMatchObject({ kind: 'tool', tool: 'Grep', target: 'refreshToken in src', result: 'error', summary: 'boom: bad regex' });
    expect(text).toMatchObject({ kind: 'text', text: 'Two triggers so far.' });
    expect(r.meta.lastAt).toBe(Date.parse(T));
  });
  test('a background Bash links to its task id', () => {
    const r = new TranscriptReader();
    r.push(enc(toolUse('t3', 'Bash', { command: 'npm run typecheck', run_in_background: true })
      + toolResult('t3', 'Command running in background with ID: bx81. Output is being written to: /p/x', false, { toolUseResult: { backgroundTaskId: 'bx81' } })));
    expect(r.entries[0]).toMatchObject({ tool: 'Bash', target: 'npm run typecheck', taskId: 'bx81' } satisfies Partial<ToolEntry>);
  });
  test('a partial last line waits for the next chunk', () => {
    const r = new TranscriptReader();
    const full = toolUse('t1', 'Read', { file_path: '/p/a.ts' });
    r.push(enc(full.slice(0, 30)));
    expect(r.entries).toEqual([]);
    r.push(enc(full.slice(30)));
    expect(r.entries).toHaveLength(1);
    expect(r.unrecognized()).toBe(false);
  });
  test('unknown types are skipped; mostly unparsable files are unrecognized', () => {
    const ok = new TranscriptReader();
    ok.push(enc(line({ type: 'summary', summary: 'x' }) + line({ type: 'system', subtype: 'y' }) + user('go')));
    expect(ok.unrecognized()).toBe(false);
    const bad = new TranscriptReader();
    bad.push(enc(Array.from({ length: 25 }, (_, i) => `not json ${i}\n`).join('')));
    expect(bad.unrecognized()).toBe(true);
    const few = new TranscriptReader();
    few.push(enc('nope\nnope\n'));
    expect(few.unrecognized()).toBe(false);
  });
  test('only the last TIMELINE_SHOWN entries are shown', () => {
    const r = new TranscriptReader();
    r.push(enc(Array.from({ length: TIMELINE_SHOWN + 10 }, (_, i) => toolUse(`t${i}`, 'Read', { file_path: `/p/f${i}.ts` })).join('')));
    expect(r.shown()).toHaveLength(TIMELINE_SHOWN);
    expect(r.meta.tools).toBe(TIMELINE_SHOWN + 10);
  });
  test('the captured Explore transcript parses into a timeline', () => {
    const r = new TranscriptReader();
    r.push(readFileSync(join(__dirname, '../../tests/fixtures/transcripts/explore-agent.jsonl')), '/p/repo');
    expect(r.unrecognized()).toBe(false);
    expect(r.meta.task).toBeTruthy();
    expect(r.meta.tools).toBeGreaterThanOrEqual(3);
    expect(r.entries.some((e) => e.kind === 'tool' && e.result !== undefined)).toBe(true);
    expect(r.entries.find((e) => e.kind === 'tool' && e.tool === 'Bash')).toMatchObject({ taskId: 'bx81', summary: 'background' });
    expect(r.entries.find((e) => e.kind === 'tool' && e.tool === 'Read')).toMatchObject({ target: 'src/auth/session.ts' });
    expect(r.entries.filter((e) => e.kind === 'tool')).toHaveLength(3);
    expect(r.entries).toHaveLength(4);
  });
  test('usage is counted once per message id', () => {
    const r = new TranscriptReader();
    const l = (content: object) => line({ type: 'assistant', timestamp: T, message: { id: 'msg_1', role: 'assistant', content: [content], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 999 } } });
    r.push(enc(l({ type: 'text', text: 'hi' }) + l({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a.ts' } })));
    expect(r.meta.tokens).toBe(120);
    expect(r.entries).toHaveLength(2);
    r.reset();
    r.push(enc(l({ type: 'text', text: 'again' })));
    expect(r.meta.tokens).toBe(120);
  });
  test('a foreground Bash gets no task id from its output text', () => {
    const r = new TranscriptReader();
    r.push(enc(toolUse('t1', 'Bash', { command: 'echo' }) + toolResult('t1', 'started with ID: foo')));
    expect(r.entries[0]).not.toHaveProperty('taskId');
  });
  test('a background Bash takes the id from the text when there is no structured one', () => {
    const r = new TranscriptReader();
    r.push(enc(toolUse('t1', 'Bash', { command: 'x', run_in_background: true }) + toolResult('t1', 'Command running in background with ID: bz9. Out')));
    expect(r.entries[0]).toMatchObject({ taskId: 'bz9', summary: 'background' });
  });
  test('the structured id wins over the text', () => {
    const r = new TranscriptReader();
    r.push(enc(toolUse('t1', 'Bash', { command: 'x', run_in_background: true }) + toolResult('t1', 'with ID: wrong', false, { toolUseResult: { backgroundTaskId: 'right' } })));
    expect(r.entries[0]).toMatchObject({ taskId: 'right' });
  });
  test('a multi-byte character split across chunks survives', () => {
    const r = new TranscriptReader();
    const bytes = enc(user('caffè ☕ ok'));
    const cut = bytes.indexOf(0xe2) + 1;
    r.push(bytes.slice(0, cut));
    r.push(bytes.slice(cut));
    expect(r.meta.task).toBe('caffè ☕ ok');
  });
  test('reset() clears everything', () => {
    const r = new TranscriptReader();
    r.push(enc(user('go') + toolUse('t1', 'Read', { file_path: '/p/a.ts' }) + 'partial'));
    r.reset();
    expect(r.entries).toEqual([]);
    expect(r.meta).toEqual({ tokens: 0, tools: 0, files: 0 });
    r.push(enc('{"type":"user","message":{"role":"user","content":"x"}}\n'));
    expect(r.meta.task).toBe('x');
  });
  test('unrecognized() flips just over half bad', () => {
    const mk = (bad: number) => { const r = new TranscriptReader(); r.push(enc(Array.from({ length: 20 }, (_, i) => (i < bad ? 'nope\n' : user('ok'))).join(''))); return r; };
    expect(mk(10).unrecognized()).toBe(false);
    expect(mk(11).unrecognized()).toBe(true);
  });
  test('startsMidFile() stops later user lines from becoming the task; reset() clears it', () => {
    const r = new TranscriptReader();
    r.startsMidFile();
    r.push(enc(user('a reply')));
    expect(r.meta.task).toBeUndefined();
    r.reset();
    r.push(enc(user('first')));
    expect(r.meta.task).toBe('first');
  });
  test('targets are redacted: a token in a command, a URL or a prompt is never shown', () => {
    const r = new TranscriptReader();
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';
    const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    r.push(enc(
      toolUse('t1', 'Bash', { command: `curl -H "Authorization: Bearer ${key}" https://api.example.com` })
      + toolUse('t2', 'WebFetch', { url: `https://example.com/hook?token=${gh}` })
      + toolUse('t3', 'Task', { prompt: `Use the key ${key} to call the API` })
    ));
    const targets = r.entries.map((e) => (e.kind === 'tool' ? e.target : ''));
    for (const target of targets) { expect(target).not.toContain(key); expect(target).not.toContain(gh); expect(target).toContain('…'); }
    expect(targets[0]).toMatch(/^curl -H "Authorization: Bearer …" https:\/\/api\.example\.com$/);
  });
  test('a file of well-formed JSON with no assistant or user line is unrecognized, from 20 lines', () => {
    const mk = (n: number, tail = '') => { const r = new TranscriptReader(); r.push(enc(Array.from({ length: n }, () => line({ type: 'progress', data: {} })).join('') + tail)); return r; };
    expect(mk(19).unrecognized()).toBe(false);
    expect(mk(20).unrecognized()).toBe(true);
    expect(mk(40, user('the task')).unrecognized()).toBe(false);
  });
  test('following a long transcript keeps memory bounded: old entries go, counters stay cumulative', () => {
    const r = new TranscriptReader();
    const n = TIMELINE_SHOWN * 3;
    const msg = (i: number) => line({ type: 'assistant', timestamp: T, message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/p/f${i}.ts` } }], usage: { input_tokens: 1, output_tokens: 0 } } });
    for (let i = 0; i < n; i++) r.push(enc(msg(i)));
    expect(r.entries.length).toBeLessThanOrEqual(TIMELINE_SHOWN * 2);
    expect(r.shown()).toHaveLength(TIMELINE_SHOWN);
    expect(r.shown().at(-1)).toMatchObject({ target: `/p/f${n - 1}.ts` });
    expect(r.meta).toMatchObject({ tools: n, files: n, tokens: n });
    const inner = r as unknown as { tools: Map<string, unknown>; seenMessages: Set<string> };
    expect(inner.tools.size).toBeLessThanOrEqual(TIMELINE_SHOWN * 2);
    expect(inner.seenMessages.size).toBeLessThanOrEqual(TIMELINE_SHOWN * 2);
    // A result for a step that left the buffer is ignored; one for a kept step still completes it.
    r.push(enc(toolResult('t0', 'old') + toolResult(`t${n - 1}`, 'a\nb')));
    expect(r.shown().at(-1)).toMatchObject({ result: 'ok', summary: '2 lines' });
  });
  test('ok summaries count lines without a trailing newline', () => {
    const r = new TranscriptReader();
    r.push(enc(toolUse('t1', 'Read', { file_path: '/p/a.ts' }) + toolResult('t1', 'a\nb\n')));
    expect(r.entries[0]).toMatchObject({ summary: '2 lines' });
  });
});
