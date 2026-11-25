import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ConversationParser } from './parse';
import { CAPS, type Entry } from './types';

const LINES = readFileSync('tests/fixtures/claude-2.1.332/transcript.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const ROOT = LINES.find((l) => typeof l.cwd === 'string')!.cwd as string;
const HOME = '/home/uuuuuuuu';
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const newParser = () => new ConversationParser({ projectRoot: ROOT, home: HOME });

/** The fixture's first `k` lines through one parser (all of them when `k` is absent). */
function parsedUpTo(k = LINES.length): ConversationParser {
  const p = newParser();
  for (const l of LINES.slice(0, k)) p.push(l);
  return p;
}

const T = '2026-11-25T10:00:00.000Z';
const prompt = (text: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: T, message: { role: 'user', content: text }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', timestamp: T, message: { role: 'assistant', content }, ...extra });
const use = (id: string, name: string, input: Record<string, unknown>) => assistant([{ type: 'tool_use', id, name, input }]);
const result = (id: string, content: unknown, toolUseResult?: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...(toolUseResult === undefined ? {} : { toolUseResult }), ...extra });
const run = (...lines: unknown[]) => { const p = newParser(); for (const l of lines) p.push(l); return p; };

describe('ConversationParser on the 2.1.332 session', () => {
  test('the 2.1.332 session\'s first seventeen entries, numbered in order, as Claude Code showed them', () => {
    const e = parsedUpTo(35).entries;
    expect(e.map((x) => x.n)).toEqual(range(1, 17));
    expect(e[0]).toMatchObject({ n: 1, k: 'prompt', text: 'Run ls with the Bash tool. Reply in one short sentence.' });
    expect(e[1]).toMatchObject({ n: 2, k: 'tool', tool: 'Bash', target: 'ls', status: 'ok', summary: '1 line', detail: 'hello.txt' });
    expect(e[2]).toMatchObject({ n: 3, k: 'reply', text: 'The directory contains one file, `hello.txt`.' });
    expect(e[7]).toMatchObject({ n: 8, k: 'tool', status: 'error', summary: 'Rejected', feedback: 'do not create it, just say ok' });
    expect(e[10]).toMatchObject({ n: 11, k: 'tool', status: 'error', summary: 'Interrupted' });
    expect(e[12]).toMatchObject({ n: 13, k: 'tool', tool: 'Read', target: 'hello.txt', summary: '3 lines' });
    expect(e[13]).toMatchObject({ n: 14, k: 'tool', tool: 'Edit', target: 'hello.txt', summary: '+1 −1', detail: '-Hello, world!\n+Hello, there!\n This file is for edit tests.' });
    expect(e[15]).toMatchObject({ n: 16, k: 'prompt', text: '/model' });
    expect(e[16]).toMatchObject({ n: 17, k: 'prompt' });
    expect(e[0]).toHaveProperty('at', Date.parse('2026-11-25T09:03:34.585Z'));
  });

  test('a tool call waits as running, with an edit\'s diff from its call; its result replaces it under the same n', () => {
    const p = parsedUpTo(29);
    expect(p.entries[13]).toMatchObject({ n: 14, tool: 'Edit', status: 'running', detail: '-world\n+there' });
    expect(p.takeChanged()).toEqual(range(1, 14));
    expect(p.takeChanged()).toEqual([]);
    expect(p.running()).toEqual([{ n: 14, k: 'tool', tool: 'Edit', waitTarget: 'Edit hello.txt' }]);
    p.push(LINES[29]);
    expect(p.entries).toHaveLength(14);
    expect(p.entries[13]).toMatchObject({ n: 14, status: 'ok', summary: '+1 −1' });
    expect(p.takeChanged()).toEqual([14]);
    expect(p.running()).toEqual([]);
  });

  test('the whole session: a background Bash, a plan approved, a mid-turn prompt, a cut-short reply', () => {
    const e = parsedUpTo().entries;
    expect(e.find((x) => x.k === 'tool' && x.summary === 'In background')).toBeTruthy();
    expect(e.find((x) => x.k === 'tool' && x.tool === 'ExitPlanMode' && x.status === 'ok')).toMatchObject({ summary: 'Approved', detail: expect.stringContaining('Bye.') });
    expect(e.find((x) => x.k === 'tool' && x.tool === 'ExitPlanMode' && x.status === 'error')).toMatchObject({ summary: 'Rejected', feedback: 'Skip the verify step.' });
    expect(e.some((x) => x.k === 'prompt' && x.text === 'What is 3+4? One word.')).toBe(true);
    expect(e.every((x, i) => x.n === i + 1)).toBe(true);
  });
});

describe('ConversationParser rules', () => {
  test('secrets are redacted before any cut, in prompts, replies, targets, outputs and feedback', () => {
    const key = 'sk-ant-api03-' + 'Ab1'.repeat(10);
    const blob = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7r';
    const p = run(
      prompt(`use ${key} and ${blob}`),
      assistant([{ type: 'text', text: `the key is ${key}` }]),
      use('t1', 'Bash', { command: `curl -H "x: ${key}" ${blob}` }),
      result('t1', `out ${key}\n${blob}`, { stdout: `out ${key}\n${blob}`, stderr: '' })
    );
    // A rejection with feedback: the words come from the line's userFeedback.
    p.push(use('t4', 'Bash', { command: 'false' }));
    p.push({ ...result('t4', 'x'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'x', is_error: true }] }, userFeedback: `never ${key}` });
    const all = JSON.stringify(p.entries);
    expect(p.entries).toHaveLength(4);
    expect(p.entries[3]).toMatchObject({ summary: 'Rejected', feedback: 'never …' });
    expect(all).not.toContain('sk-ant');
    expect(all).not.toContain(blob);
    expect(all).not.toContain('Ab1Ab1Ab1');
    expect(all).toContain('…');
  });

  test('a secret in a rejection\'s feedback never reaches the entry', () => {
    const key = 'sk-ant-api03-' + 'Ab1'.repeat(10);
    const p = run(
      use('t1', 'Bash', { command: 'ls' }),
      { ...result('t1', 'rejected', 'Error: x'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'rejected', is_error: true }] }, userFeedback: `use ${key} instead` }
    );
    expect(p.entries[0]).toMatchObject({ summary: 'Rejected' });
    expect(JSON.stringify(p.entries)).not.toContain('sk-ant');
    expect((p.entries[0] as { feedback: string }).feedback).toContain('use');
  });

  test('long texts are cut to their caps: a reply at 32 KiB, an output tail at 20 lines and 2 KiB', () => {
    const outLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const wide = Array.from({ length: 10 }, (_, i) => `w${i}-${'x'.repeat(400)}`).join('\n');
    const p = run(
      prompt('p'.repeat(40000)),
      assistant([{ type: 'text', text: 'r'.repeat(100000) }]),
      use('a', 'Bash', { command: 'seq' }), result('a', outLines, { stdout: outLines, stderr: '' }),
      use('b', 'Bash', { command: 'wide' }), result('b', wide, { stdout: wide, stderr: '' })
    );
    const [pr, re, a, b] = p.entries as Entry[];
    expect((pr as { text: string }).text.length).toBeLessThanOrEqual(CAPS.prompt);
    expect((re as { text: string }).text.length).toBeLessThanOrEqual(CAPS.reply);
    const aDetail = (a as { detail: string }).detail;
    expect(aDetail.split('\n')).toHaveLength(20);
    expect(aDetail.endsWith('line 99')).toBe(true);
    expect((a as { summary: string }).summary).toBe('100 lines');
    const bDetail = (b as { detail: string }).detail;
    expect(bDetail.length).toBeLessThanOrEqual(CAPS.output);
    expect(bDetail.endsWith('x'.repeat(50))).toBe(true);
    expect(bDetail).toContain('w9-');
    expect(bDetail).not.toContain('characters cut');
  });

  test('sidechain, meta, compaction summary, thinking and unknown lines add nothing', () => {
    const p = run(
      prompt('side', { isSidechain: true }),
      prompt('meta', { isMeta: true }),
      prompt('summary of the past', { isCompactSummary: true }),
      assistant([{ type: 'thinking', thinking: 'hmm' }]),
      assistant([{ type: 'text', text: '(no content)' }]),
      assistant([{ type: 'text', text: 'side reply' }], { isSidechain: true }),
      { type: 'permission-mode', permissionMode: 'default' },
      { type: 'queue-operation', content: 'x' },
      { type: 'weird' },
      'not an object',
      null,
      prompt('<local-command-stdout>ok</local-command-stdout>'),
      prompt('<bash-stdout>ok</bash-stdout>'),
      prompt('[Request interrupted by user for tool use]'),
      prompt([{ type: 'text', text: '[Request interrupted by user]' }]),
      prompt('<system-reminder>only a reminder</system-reminder>'),
      prompt('<task-notification>x</task-notification>')
    );
    expect(p.entries).toEqual([]);
    expect(p.takeChanged()).toEqual([]);
  });

  test('prompts: reminders stripped, text parts joined, commands and bash mode as typed', () => {
    const p = run(
      prompt('<system-reminder>r</system-reminder>hello'),
      prompt([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]),
      prompt('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 42</command-args>'),
      { type: 'system', subtype: 'local_command', timestamp: T, content: '<command-name>/model</command-name><command-args></command-args>' },
      prompt('<bash-input>ls -la</bash-input>'),
      { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: 'queued one' } }
    );
    expect(p.entries.map((e) => (e as { text: string }).text)).toEqual(['hello', 'one\ntwo', '/review PR 42', '/model', '! ls -la', 'queued one']);
  });

  test('a result without its call, and a tool of the next task, add nothing', () => {
    const p = run(result('ghost', 'x', {}), use('q', 'AskUserQuestion', { questions: [] }), result('q', 'answered'));
    expect(p.entries).toEqual([]);
  });
});
