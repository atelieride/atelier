import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ConversationParser } from './parse';
import { CAPS, type Entry } from './types';

type ToolEntry = Extract<Entry, { k: 'tool' }>;

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
    expect(e.find((x) => x.k === 'tool' && x.summary === 'In background')).toBeUndefined(); // its notice settled it
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
      { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: 'queued one', commandMode: 'prompt' } },
      prompt('<command-message>review-tools:checklist</command-message>\n<command-name>/review-tools:checklist</command-name>\n<command-args>docs/plan.md</command-args>'),
      prompt('Caveat: this is something I typed myself')
    );
    expect(p.entries.map((e) => (e as { text: string }).text)).toEqual(['hello', 'one\ntwo', '/review PR 42', '/model', '! ls -la', 'queued one', '/review-tools:checklist docs/plan.md', 'Caveat: this is something I typed myself']);
    expect(p.entries.filter((e) => e.k === 'prompt' && e.text === 'queued one')).toHaveLength(1);
  });

  test('a result without its call, and a tool that becomes another kind of entry, add nothing', () => {
    const p = run(result('ghost', 'x', {}), use('q', 'AskUserQuestion', { questions: [] }), result('q', 'answered'));
    expect(p.entries).toEqual([]);
  });
  test('a key sitting on each cut is redacted before the cut: an output\'s 2 KiB tail, a path, a prompt\'s middle', () => {
    const key = 'sk-ant-api03-' + 'Ab1'.repeat(10);
    const fragment = 'Ab1Ab1Ab1Ab1';
    // The output's kept tail starts 20 characters into the key.
    const out = 'w '.repeat(500) + key + ' z'.repeat(1012);
    const path = `/elsewhere/${'d'.repeat(128)}/${key}/${'e'.repeat(116)}`;
    expect(path.length).toBe(300);
    const prompts = Array.from({ length: 460 }, () => key).join(' ');
    const p = run(
      use('a', 'Bash', { command: 'cat' }), result('a', out, { stdout: out, stderr: '' }),
      use('b', 'Read', { file_path: path }),
      prompt(prompts)
    );
    const [o, r, pr] = [p.entries[0] as ToolEntry, p.entries[1] as ToolEntry, p.entries[2] as { text: string }];
    for (const text of [o.detail!, r.target!, pr.text]) {
      expect(text).not.toContain('sk-ant');
      expect(text).not.toContain(fragment);
    }
    expect(o.detail!.length).toBeLessThanOrEqual(CAPS.output);
    expect(o.detail!.endsWith('z')).toBe(true);
    expect(r.target!.length).toBeLessThanOrEqual(CAPS.target);
  });

  test('a failing command keeps the end of its message: its last line, at most 20 lines', () => {
    const body = Array.from({ length: 1000 }, (_, i) => (i === 999 ? 'LAST' : 'x')).join('\n');
    const p = run(use('a', 'Bash', { command: 'boom' }));
    p.push({ ...result('a', ''), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: `<tool_use_error>${body}</tool_use_error>`, is_error: true }] } });
    const e = p.entries[0] as ToolEntry;
    expect(e.status).toBe('error');
    expect(e.detail!.endsWith('LAST')).toBe(true);
    expect(e.detail!.split('\n').length).toBeLessThanOrEqual(80);
  });

  test('a rejection\'s feedback and a long target stay within their caps', () => {
    const p = run(use('a', 'Bash', { command: 'x'.repeat(500) }));
    p.push({ ...result('a', 'no'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'no', is_error: true }] }, userFeedback: 'f '.repeat(3000) });
    const e = p.entries[0] as ToolEntry;
    expect(e.target!.length).toBeLessThanOrEqual(CAPS.target);
    expect(e.summary).toBe('Rejected');
    expect(e.feedback!.length).toBeLessThanOrEqual(CAPS.feedback);
    expect(e.feedback!.length).toBeGreaterThan(1000);
  });

  test('a tool name is kept to word characters, dots, colons and dashes, at most 80', () => {
    const p = run(use('a', 'Bad Name!<x>', {}), use('b', 'm'.repeat(200), {}), use('c', '!!!', {}));
    expect((p.entries as ToolEntry[]).map((e) => e.tool)).toEqual(['BadNamex', 'm'.repeat(80), 'Tool']);
  });
});

const ask = (questions: unknown[]) => ({ questions });
const notice = (id: string, status: string, summary: string, resultText?: string) =>
  prompt(`<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>${resultText === undefined ? '' : `\n<result>${resultText}</result>`}\n</task-notification>`);
const COMPANION = readFileSync('tests/fixtures/companion/session.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('ConversationParser: agents, questions, plans, todos, compaction, queue, interrupts', () => {
  test('the whole 2.1.332 session: 60 entries in order, 16 replies; a blocked call; a background one, then its notice', () => {
    const e = parsedUpTo().entries;
    expect(e.map((x) => x.n)).toEqual(range(1, 60));
    expect(e.filter((x) => x.k === 'reply').length).toBe(16);
    expect(e[38]).toMatchObject({ n: 39, k: 'tool', status: 'error', summary: expect.stringMatching(/^Blocked: sleep 25 followed by/) });
    expect(parsedUpTo(79).entries[39]).toMatchObject({ n: 40, k: 'tool', status: 'running', summary: 'In background' });
    expect(e[51]).toMatchObject({ n: 52, k: 'tool', tool: 'Write', target: expect.stringMatching(/^~\/\.claude-xxx\/plans\//) });
  });

  test('2.1.332: questions and their answers, the plan rejected then approved, the queued prompt, the interrupts', () => {
    const e = parsedUpTo().entries;
    expect(e[17]).toMatchObject({ n: 18, k: 'question', status: 'ok', questions: [{ header: 'Color', question: 'What is your favorite color?', options: [{ label: 'Red', description: 'Red' }, { label: 'Green', description: 'Green' }, { label: 'Blue', description: 'Blue' }] }] });
    expect(e[18]).toMatchObject({ n: 19, k: 'answer', text: 'Green' });
    expect(e[22]).toMatchObject({ n: 23, k: 'answer', text: 'Mango' });
    expect(e[26]).toMatchObject({ n: 27, k: 'answer', text: 'What is your favorite season? → Winter\nWhat is your favorite drink? → Tea' });
    expect(e[29]).toMatchObject({ n: 30, k: 'question', questions: [{ several: true }] });
    expect(e[30]).toMatchObject({ n: 31, k: 'answer', text: 'Cats, Fish' });
    expect(e[39]).toMatchObject({ n: 40, summary: 'Done' }); // the notification, no new entry
    expect(e[46]).toMatchObject({ n: 47, k: 'prompt', text: 'What is 3+4? One word.' }); // queued, delivered mid-turn
    expect(e[53]).toMatchObject({ n: 54, k: 'tool', tool: 'ExitPlanMode', status: 'error', summary: 'Rejected', feedback: 'Skip the verify step.', detail: expect.stringMatching(/^# Plan\n1\. Append/) });
    expect(e[55]).toMatchObject({ n: 56, k: 'tool', tool: 'ExitPlanMode', status: 'ok', summary: 'Approved' });
    expect(e[10]).toMatchObject({ n: 11, status: 'error', summary: 'Interrupted', interrupted: true });
    expect(e[59]).toMatchObject({ n: 60, k: 'reply', interrupted: true });
    expect(e[0]).not.toHaveProperty('interrupted');
  });

  test('the Ask fixture: a foreground agent\'s report, a background agent reported by its notification, todos, compaction', () => {
    const run1 = (k: number) => { const p = newParser(); for (const l of COMPANION.slice(0, k)) p.push(l); return p; };
    const agents = (p: ConversationParser) => p.entries.filter((x): x is Extract<Entry, { k: 'agent' }> => x.k === 'agent');
    const full = run1(COMPANION.length);
    const [fg, bg] = agents(full);
    expect(fg).toMatchObject({ description: 'Review the session fix', status: 'ok' });
    expect(fg!.report).toMatch(/^REPORT-HEAD/);
    expect(fg!.report).not.toContain('agentId');
    expect(bg).toMatchObject({ description: 'Run the e2e suite', status: 'ok', report: 'E2E: 42 passed, 0 failed. The login flow is green.' });
    // After its launch and before its notification the background agent still runs, without a report.
    expect(agents(run1(42))[1]).toMatchObject({ description: 'Run the e2e suite', status: 'running' });
    expect(agents(run1(42))[1]).not.toHaveProperty('report');
    // A TodoWrite each, the three of them apart; one compaction; the image prompt keeps its text, redacted.
    const todos = full.entries.filter((x) => x.k === 'todos');
    expect(todos).toHaveLength(3);
    expect(todos[0]).toMatchObject({ items: [{ text: 'Session expiry', status: 'in_progress' }, { text: 'Refresh token rotation', status: 'pending' }, expect.anything()] });
    expect(todos[2]).toMatchObject({ items: [{ status: 'completed' }, { status: 'completed' }, expect.anything()] });
    expect(full.entries.filter((x) => x.k === 'compact')).toHaveLength(1);
    const image = full.entries.find((x) => x.k === 'prompt' && x.text.startsWith('Now do point 3'));
    expect(image).toBeTruthy();
    expect(JSON.stringify(full.entries)).not.toContain('ghp_R4nd0m');
    expect(full.entries.find((x) => x.k === 'answer')).toMatchObject({ text: 'Every use' });
  });

  test('a question still waiting is running, and running() names it; the plan waiting too', () => {
    const p = parsedUpTo(36);
    expect(p.entries.at(-1)).toMatchObject({ k: 'question', status: 'running' });
    expect(p.running()).toEqual([{ n: 18, k: 'question', tool: 'AskUserQuestion', waitTarget: 'question' }]);
    const plan = parsedUpTo(104);
    expect(plan.running()).toEqual([expect.objectContaining({ k: 'tool', tool: 'ExitPlanMode', waitTarget: 'plan approval' })]);
    expect(parsedUpTo(37).running()).toEqual([]);
  });

  test('a queued prompt shows once, when Claude takes it, never at enqueue', () => {
    const p = run(
      use('a', 'Bash', { command: 'sleep 12' }),
      { type: 'queue-operation', operation: 'enqueue', timestamp: T, content: 'What is 3+4? One word.' }
    );
    expect(p.entries.filter((e) => e.k === 'prompt')).toEqual([]);
    p.push({ type: 'queue-operation', operation: 'remove', timestamp: T, content: 'What is 3+4? One word.' });
    p.push(result('a', 'done', { stdout: 'done', stderr: '' }));
    expect(p.entries.filter((e) => e.k === 'prompt')).toEqual([]);
    p.push({ type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: 'What is 3+4? One word.', commandMode: 'prompt' } });
    expect(p.entries.filter((e) => e.k === 'prompt')).toHaveLength(1);
    expect(p.entries.at(-1)).toMatchObject({ k: 'prompt', text: 'What is 3+4? One word.' });
  });

  test('a queued attachment that is not a plain prompt adds no prompt', () => {
    const p = run(
      { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: 'ls', commandMode: 'bash' } },
      { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '<system-reminder>x</system-reminder>', commandMode: 'prompt' } },
      { type: 'attachment', timestamp: T, attachment: { type: 'queued_command', prompt: '<task-notification>y</task-notification>', commandMode: 'prompt' } }
    );
    expect(p.entries).toEqual([]);
  });

  test('an agent: its description, else its subagent type; a foreground result is its report without Claude\'s metadata', () => {
    const p = run(
      use('a', 'Agent', { description: 'Check it', prompt: 'p' }), use('b', 'Task', { subagent_type: 'reviewer', prompt: 'p' }),
      result('a', [{ type: 'text', text: 'All fine.\nagentId: a1b2 (internal)\n<usage>total_tokens: 5</usage>' }], { status: 'completed' })
    );
    expect(p.entries[0]).toMatchObject({ n: 1, k: 'agent', description: 'Check it', status: 'ok', report: 'All fine.' });
    expect(p.entries[1]).toMatchObject({ n: 2, k: 'agent', description: 'reviewer', status: 'running' });
    expect(p.running()).toEqual([{ n: 2, k: 'agent', tool: 'Task', waitTarget: 'Task' }]);
  });

  test('a background agent: the launch keeps it running; its notification settles it (completed ok, else error)', () => {
    const launch = (id: string) => result(id, 'Async agent launched successfully.\nagentId: z', { isAsync: true, status: 'async_launched' });
    const p = run(
      use('a', 'Agent', { description: 'One', run_in_background: true }), launch('a'),
      use('b', 'Agent', { description: 'Two', run_in_background: true }), launch('b')
    );
    expect(p.entries.map((e) => (e as { status: string }).status)).toEqual(['running', 'running']);
    expect(p.running()).toEqual([]);
    p.takeChanged();
    p.push(notice('a', 'completed', 'Agent "One" completed', 'Report one'));
    p.push(notice('b', 'failed', 'Agent "Two" failed', 'It broke'));
    p.push(notice('nope', 'completed', 'x', 'ignored'));
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]).toMatchObject({ status: 'ok', report: 'Report one' });
    expect(p.entries[1]).toMatchObject({ status: 'error', report: 'It broke' });
    expect(p.takeChanged()).toEqual([1, 2]);
  });

  test('a background Bash: "Done" for exit code 0, "Exit N" and an error otherwise', () => {
    const bg = (id: string) => [use(id, 'Bash', { command: 'sleep 1', run_in_background: true }), result(id, 'Command running in background', { backgroundTaskId: 'q', stdout: '', stderr: '' })];
    const p = run(...bg('a'), ...bg('b'), ...bg('c'));
    p.push(notice('a', 'completed', 'Background command "x" completed (exit code 0)'));
    p.push(notice('b', 'failed', 'Background command "x" failed with exit code 3 (exit code 3)'));
    p.push(notice('c', 'killed', 'Background command "x" was stopped'));
    expect(p.entries[0]).toMatchObject({ status: 'ok', summary: 'Done' });
    expect(p.entries[1]).toMatchObject({ status: 'error', summary: 'Exit 3' });
    expect(p.entries[2]).toMatchObject({ status: 'error' });
    expect(p.entries[2]).not.toMatchObject({ summary: 'In background' });
    expect(p.entries).toHaveLength(3);
  });

  test('a notice that arrives as a queued attachment settles the call too', () => {
    const p = run(use('a', 'Bash', { command: 'x', run_in_background: true }), result('a', 'bg', { backgroundTaskId: 'q' }));
    p.push({ type: 'attachment', timestamp: T, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<tool-use-id>a</tool-use-id>\n<status>completed</status>\n<summary>done (exit code 0)</summary>\n</task-notification>' } });
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ summary: 'Done', status: 'ok' });
  });

  test('a question: its fields capped, its answer a new entry, a rejection an error with no answer', () => {
    const q = (extra: Record<string, unknown>) => ask([{ question: 'Pick?', header: 'H'.repeat(100), multiSelect: true, options: Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`.repeat(80), description: 'd'.repeat(500) })), ...extra }, { question: '' }, ...Array.from({ length: 6 }, () => ({ question: 'more', options: [] }))]);
    const p = run(use('a', 'AskUserQuestion', q({})));
    const e = p.entries[0] as Extract<Entry, { k: 'question' }>;
    expect(e.questions).toHaveLength(CAPS.questions);
    expect(e.questions[0]!.header!.length).toBeLessThanOrEqual(CAPS.header);
    expect(e.questions[0]!.options).toHaveLength(CAPS.options);
    expect(e.questions[0]!.options[0]!.label.length).toBeLessThanOrEqual(CAPS.label);
    expect(e.questions[0]!.options[0]!.description!.length).toBeLessThanOrEqual(CAPS.description);
    expect(e.questions[0]).toMatchObject({ several: true });
    expect(e.questions[1]).not.toHaveProperty('several');
    const rej = run(use('a', 'AskUserQuestion', ask([{ question: 'Pick?', options: [{ label: 'A' }] }])));
    rej.push({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: "The user doesn't want to proceed with this tool use.", is_error: true }] }, toolUseResult: 'User rejected tool use' });
    expect(rej.entries).toHaveLength(1);
    expect(rej.entries[0]).toMatchObject({ k: 'question', status: 'error' });
    expect(rej.running()).toEqual([]);
  });

  test('an answer comes from the structured result, else from the text pairs; several lines; redacted; capped', () => {
    const key = 'sk-ant-api03-' + 'Ab1'.repeat(10);
    const one = { question: 'Q1?', options: [{ label: 'A' }] };
    const fromText = run(use('a', 'AskUserQuestion', ask([one])), result('a', 'User has answered your questions: "Q1?"="Blue". Carry on.'));
    expect(fromText.entries[1]).toMatchObject({ k: 'answer', text: 'Blue' });
    const two = run(use('a', 'AskUserQuestion', ask([one, { ...one, question: 'Q2?' }])), result('a', 'x', { answers: { 'Q1?': 'A', 'Q2?': ['B', 'C'] } }));
    expect(two.entries[1]).toMatchObject({ k: 'answer', text: 'Q1? → A\nQ2? → B, C' });
    const long = run(use('a', 'AskUserQuestion', ask([one])), result('a', 'x', { answers: { 'Q1?': `use ${key} ` + 'w '.repeat(5000) } }));
    const text = (long.entries[1] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(CAPS.answer);
    expect(text).not.toContain('sk-ant');
    const none = run(use('a', 'AskUserQuestion', ask([one])), result('a', 'nothing useful here'));
    expect(none.entries).toHaveLength(1);
    expect(none.entries[0]).toMatchObject({ status: 'ok' });
  });

  test('todos: TodoWrite items; TaskCreate/TaskUpdate keep a list; a todos right after a todos replaces it', () => {
    const write = (id: string, ...status: string[]) => use(id, 'TodoWrite', { todos: status.map((s, i) => ({ content: `Step ${i}`, status: s, activeForm: 'x' })) });
    const p = run(write('a', 'pending', 'pending'), write('b', 'in_progress', 'pending'));
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ n: 1, k: 'todos', items: [{ text: 'Step 0', status: 'in_progress' }, { text: 'Step 1', status: 'pending' }] });
    expect(p.takeChanged()).toEqual([1]);
    p.push(assistant([{ type: 'text', text: 'between' }]));
    p.push(write('c', 'completed', 'completed'));
    expect(p.entries.map((e) => e.k)).toEqual(['todos', 'reply', 'todos']);
    expect(p.entries.length).toBe(3);

    const t = run(
      use('c1', 'TaskCreate', { subject: 'First' }), result('c1', 'Task #1 created successfully: First', { task: { id: '1', subject: 'First' } }),
      use('c2', 'TaskCreate', { subject: 'Second' }), result('c2', 'Task #2 created successfully: Second', { task: { id: '2', subject: 'Second' } }),
      use('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })
    );
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]).toMatchObject({ k: 'todos', items: [{ text: 'First', status: 'completed' }, { text: 'Second', status: 'pending' }] });
    expect(t.running()).toEqual([]);
    const bad = run(use('x', 'TodoWrite', { todos: 'nope' }), use('y', 'TaskList', {}));
    expect(bad.entries).toEqual([]);
  });

  test('a compact_boundary line is a compact entry', () => {
    const p = run(prompt('hi'), { type: 'system', subtype: 'compact_boundary', timestamp: T, content: 'Conversation compacted' });
    expect(p.entries[1]).toEqual({ n: 2, k: 'compact', at: Date.parse(T) });
  });

  test('an interrupt marks the newest entry, once, and nothing else; with none yet it adds nothing', () => {
    expect(run(prompt('[Request interrupted by user]')).entries).toEqual([]);
    const p = run(prompt('go'), assistant([{ type: 'text', text: 'working' }]), prompt([{ type: 'text', text: '[Request interrupted by user]' }]));
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]).not.toHaveProperty('interrupted');
    expect(p.entries[1]).toMatchObject({ k: 'reply', interrupted: true });
    expect(p.takeChanged()).toEqual([1, 2]);
  });

  test('calls left without a result when Esc is pressed are settled and leave running()', () => {
    const p = run(
      use('a', 'Bash', { command: 'sleep 99' }), use('b', 'AskUserQuestion', ask([{ question: 'Q?', options: [{ label: 'A' }] }])),
      use('c', 'Agent', { description: 'Slow' }), use('d', 'Read', { file_path: 'x' }), result('d', '1\tx', { file: { numLines: 1 } })
    );
    expect(p.running()).toHaveLength(3);
    p.takeChanged();
    p.push(prompt('[Request interrupted by user for tool use]'));
    expect(p.running()).toEqual([]);
    expect(p.entries[0]).toMatchObject({ status: 'error', summary: 'Interrupted' });
    expect(p.entries[1]).toMatchObject({ k: 'question', status: 'error' });
    expect(p.entries[2]).toMatchObject({ k: 'agent', status: 'error' });
    expect(p.entries[3]).toMatchObject({ status: 'ok', interrupted: true });
    expect(p.takeChanged()).toEqual([1, 2, 3, 4]);
    // A late result for a settled call changes nothing.
    p.push(result('a', 'late', { stdout: 'late', stderr: '' }));
    expect(p.entries[0]).toMatchObject({ status: 'error', summary: 'Interrupted' });
  });

  test('a background call whose launch came is not settled by an interrupt', () => {
    const p = run(use('a', 'Bash', { command: 'x', run_in_background: true }), result('a', 'bg', { backgroundTaskId: 'q' }), prompt('[Request interrupted by user]'));
    expect(p.entries[0]).toMatchObject({ status: 'running', summary: 'In background' });
    p.push(notice('a', 'completed', 'done (exit code 0)'));
    expect(p.entries[0]).toMatchObject({ summary: 'Done' });
  });

  test('a Bash stopped by Esc while it ran reads as interrupted, whatever shape its result takes', () => {
    const ok = run(use('a', 'Bash', { command: 'sleep 99' }), result('a', 'partial\n', { stdout: 'partial\n', stderr: '', interrupted: true }));
    expect(ok.entries[0]).toMatchObject({ status: 'error', summary: 'Interrupted' });
    const err = run(use('a', 'Bash', { command: 'sleep 99' }));
    err.push({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '[Request interrupted by user for tool use]', is_error: true }] } });
    expect(err.entries[0]).toMatchObject({ status: 'error', summary: 'Interrupted' });
    const fine = run(use('a', 'Bash', { command: 'ls' }), result('a', 'x', { stdout: 'x', stderr: '', interrupted: false }));
    expect(fine.entries[0]).toMatchObject({ status: 'ok', summary: '1 line' });
  });

  test('running() keeps the unredacted waitTarget, which no entry carries', () => {
    const key = 'sk-ant-api03-' + 'Ab1'.repeat(10);
    const p = run(use('a', 'Bash', { command: `curl ${key}` }));
    expect(p.running()[0]!.waitTarget).toContain('sk-ant');
    expect(JSON.stringify(p.entries)).not.toContain('sk-ant');
    expect(JSON.stringify(p.entries)).not.toContain('waitTarget');
  });

  test('a background Bash reads running / "In background" until its notification, is never in running(), and stays so without one', () => {
    const p = run(use('a', 'Bash', { command: 'npm run dev', run_in_background: true }), result('a', 'bg', { backgroundTaskId: 'q', stdout: '', stderr: '' }), use('b', 'Bash', { command: 'sleep 1', run_in_background: true }), result('b', 'bg', { backgroundTaskId: 'r', stdout: '', stderr: '' }));
    expect(p.entries[0]).toMatchObject({ status: 'running', summary: 'In background' });
    expect(p.running()).toEqual([]);
    p.push(notice('a', 'completed', 'Background command "npm run dev" completed (exit code 0)'));
    expect(p.entries[0]).toMatchObject({ status: 'ok', summary: 'Done' });
    expect(p.entries[1]).toMatchObject({ status: 'running', summary: 'In background' });
    p.push(notice('b', 'failed', 'Background command "x" failed (exit code 2)'));
    expect(p.entries[1]).toMatchObject({ status: 'error', summary: 'Exit 2' });
    expect(p.running()).toEqual([]);
  });

  test('the last "(exit code N)" of a notification summary counts, not one inside the command\'s description', () => {
    const p = run(use('a', 'Bash', { command: 'x', run_in_background: true }), result('a', 'bg', { backgroundTaskId: 'q' }));
    p.push(notice('a', 'completed', 'Background command "echo (exit code 1)" completed (exit code 0)'));
    expect(p.entries[0]).toMatchObject({ status: 'ok', summary: 'Done' });
  });
});
