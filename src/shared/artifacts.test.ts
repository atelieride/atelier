import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ArtifactLog, MAX_ARTIFACTS } from './artifacts';

const capture = readFileSync(resolve(__dirname, '../../tests/fixtures/transcripts/artifact-publish.jsonl'), 'utf8');
const FIRST = 'https://claude.ai/artifact/Kq3vT8xYzW2mNpR5sLd9Fa';
const SECOND = 'https://claude.ai/artifact/Rt6uY8iOp2aSd4fGh6jKl8';
const EXPECTED = [
  { url: SECOND, title: 'Pari · giro UX 1', at: Date.parse('2026-11-16T19:20:03.000Z') },
  // Its last publish is the update: the asset upload and the read after it don't count.
  { url: FIRST, title: 'Concept board', at: Date.parse('2026-11-15T15:54:24.000Z') }
];

// One Artifact call and its result, as Claude Code writes them to the session's transcript.
const call = (id: string, input: Record<string, unknown>, ts = '2026-11-16T10:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Artifact', input }] } }) + '\n';
const result = (id: string, out: unknown, ts = '2026-11-16T10:00:01.000Z', isError = false) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', ...(isError ? { is_error: true } : {}) }] }, toolUseResult: out }) + '\n';
const publish = (id: string, url: string, title?: string, ts?: string) => call(id, { action: 'publish', ...(title ? { title } : {}) }, ts) + result(id, { url, ...(title ? { title } : {}), owned: true }, ts);

const scan = (text: string) => { const log = new ArtifactLog(); log.push(text); return log.list(); };

describe('ArtifactLog', () => {
  test('the artifacts a session created or published to, newest first, from a transcript shaped like Claude Code\'s', () => {
    expect(scan(capture)).toEqual(EXPECTED);
  });

  test('the same transcript read in pieces (a line cut anywhere, the "·" split from its line) gives the same list', () => {
    for (const size of [37, 1000, 4096]) {
      const log = new ArtifactLog();
      for (let i = 0; i < capture.length; i += size) log.push(capture.slice(i, i + size));
      expect(log.list(), `pieces of ${size}`).toEqual(EXPECTED);
    }
    const log = new ArtifactLog();
    for (const ch of capture) log.push(ch);
    expect(log.list()).toEqual(EXPECTED);
  });

  test('published in the same second: the later publish first', () => {
    const ts = '2026-11-16T10:00:00.000Z';
    expect(scan(publish('t1', FIRST, 'A', ts) + publish('t2', SECOND, 'B', ts)).map((a) => a.title)).toEqual(['B', 'A']);
    // Updated after, in that same second: first again.
    expect(scan(publish('t1', FIRST, 'A', ts) + publish('t2', SECOND, 'B', ts) + publish('t3', FIRST, 'A', ts)).map((a) => a.title)).toEqual(['A', 'B']);
  });

  test('push says whether the list changed', () => {
    const log = new ArtifactLog();
    expect(log.push(call('t1', { action: 'publish', title: 'A' }))).toBe(false);
    expect(log.push(result('t1', { url: `${FIRST}`, title: 'A' }))).toBe(true);
    expect(log.push(call('t2', { action: 'read', url: FIRST }) + result('t2', { url: FIRST }))).toBe(false);
    expect(log.push('{"type":"user","message":{"role":"user","content":"hello"}}\n')).toBe(false);
  });

  test('resultSeen: false until the call\'s result line is read', () => {
    const log = new ArtifactLog();
    log.push(call('t1', { action: 'publish', title: 'A' }));
    expect(log.resultSeen('t1')).toBe(false);
    log.push(result('t1', { url: FIRST, title: 'A' }));
    expect(log.resultSeen('t1')).toBe(true);
    expect(log.resultSeen('t9')).toBe(false);
  });

  test('a delete removes the artifact; a delete that failed keeps it', () => {
    const base = publish('t1', FIRST, 'A') + publish('t2', SECOND, 'B', '2026-11-16T11:00:00.000Z');
    const failed = call('t3', { action: 'delete', url: FIRST }) + result('t3', 'Error: not allowed', undefined, true);
    expect(scan(base + failed).map((a) => a.url)).toEqual([SECOND, FIRST]);
    const deleted = call('t4', { action: 'delete', url: FIRST }) + result('t4', { deleted: true });
    expect(scan(base + failed + deleted).map((a) => a.url)).toEqual([SECOND]);
  });

  test('only https://claude.ai artifact pages count', () => {
    for (const url of ['https://claude.ai.other.invalid/artifact/abcdefgh', 'http://claude.ai/artifact/abcdefgh', 'https://claude.ai/artifact/../x', 'https://claude.ai/artifact/abc', 'javascript:alert(1)']) {
      expect(scan(publish('t1', url, 'A')), url).toEqual([]);
    }
    expect(scan(publish('t1', 'https://claude.ai/code/artifact/0b5c8f8e-3a3e-4c1f-9d0a-7f1e2d3c4b5a', 'A')).map((a) => a.url)).toEqual(['https://claude.ai/code/artifact/0b5c8f8e-3a3e-4c1f-9d0a-7f1e2d3c4b5a']);
  });

  test('titles: one line, no control or direction characters, at most 120 chars; none at all → the id', () => {
    const [a] = scan(publish('t1', FIRST, `Plan\n‮${'x'.repeat(300)}`));
    expect(a!.title.length).toBeLessThanOrEqual(120);
    expect(a!.title.startsWith('Plan x')).toBe(true);
    expect(a!.title.endsWith('…')).toBe(true);
    expect(a!.title).not.toMatch(/[\u0000-\u001f‮]/);
    expect(scan(call('t2', { action: 'publish' }) + result('t2', { url: SECOND }))[0]!.title).toBe('Rt6uY8iOp2aSd4fGh6jKl8');
    // An update without a title keeps the one it had.
    expect(scan(publish('t3', FIRST, 'Kept') + call('t4', { url: FIRST, file_path: '/work/a.html' }) + result('t4', { url: FIRST }))[0]!.title).toBe('Kept');
  });

  test(`at most ${MAX_ARTIFACTS}, the newest kept`, () => {
    let text = '';
    for (let i = 0; i < 60; i++) text += publish(`t${i}`, `https://claude.ai/artifact/Art${String(i).padStart(6, '0')}`, `A${i}`, new Date(Date.UTC(2026, 10, 16, 10, i)).toISOString());
    const list = scan(text);
    expect(list).toHaveLength(MAX_ARTIFACTS);
    expect(list[0]!.title).toBe('A59');
    expect(list.at(-1)!.title).toBe('A10');
  });

  test('an asset upload is not a publish of the page, even with the page\'s url in its result', () => {
    const upload = call('t2', { action: 'publish', url: FIRST, asset: true, file_paths: ['/work/a.png'] }, '2026-11-16T12:00:00.000Z')
      + result('t2', { url: FIRST, title: 'Upload' }, '2026-11-16T12:00:01.000Z');
    expect(scan(publish('t1', FIRST, 'A') + upload)).toEqual([{ url: FIRST, title: 'A', at: Date.parse('2026-11-16T10:00:01.000Z') }]);
  });

  test('a result whose call was never read (before where reading started) is ignored', () => {
    expect(scan(result('t1', { url: FIRST, title: 'A' }))).toEqual([]);
  });

  test('reading from inside the file: the cut first line is dropped, the rest read', () => {
    const text = publish('t1', FIRST, 'A') + publish('t2', SECOND, 'B', '2026-11-16T11:00:00.000Z');
    const log = new ArtifactLog();
    // The read started a few characters into the first call's line: only the second artifact can be told.
    log.push(text.slice(5));
    expect(log.list().map((a) => a.title)).toEqual(['B']);
  });
});
