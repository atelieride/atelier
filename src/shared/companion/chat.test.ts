import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initPlatform, resetPlatformForTests } from '../platform';
import { AGENT_MAX, CHAT_CAP, chatEntries, cloneChatState, pruneChat, renderChat, type ChatEntry, type ChatState } from './chat';

const ROOT = '/p/app';
const ms = (iso: string) => Date.parse(iso);
const pad = (n: number) => String(n).padStart(2, '0');
/** Local HH:MM, as the digest prints it. */
const hhmm = (iso: string) => { const d = new Date(ms(iso)); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const day = (iso: string) => { const d = new Date(ms(iso)); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const bytes = (s: string) => Buffer.byteLength(s);
const fresh = (): ChatState => ({ prompts: 0, tools: {} });

function fixture(): ChatEntry[] {
  const st = fresh();
  return readFileSync('tests/fixtures/companion/session.jsonl', 'utf8').split('\n').filter(Boolean)
    .flatMap((l) => chatEntries(JSON.parse(l), ROOT, st));
}
const of = <K extends ChatEntry['k']>(entries: ChatEntry[], k: K) => entries.filter((e): e is Extract<ChatEntry, { k: K }> => e.k === k);

const T = '2026-10-31T11:00:00.000Z';
const assistant = (content: unknown[], timestamp = T) => ({ type: 'assistant', timestamp, message: { role: 'assistant', content } });
const use = (id: string, name: string, input: Record<string, unknown>) => assistant([{ type: 'tool_use', id, name, input }]);
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra });
const prompt = (text: string, timestamp = T) => ({ type: 'user', timestamp, message: { role: 'user', content: text } });

describe('chatEntries on a real session', () => {
  it('keeps the conversation in order: prompts, replies, one line per tool call, agent results, questions and answers, todos, compactions', () => {
    expect(fixture().map((e) => e.k)).toEqual([
      'prompt', 'reply', 'reply', 'tool', 'todos', 'tool', 'tool', 'reply', 'tool', 'agent', 'todos', 'question', 'answer', 'tool', 'tool', 'todos', 'compact',
      'prompt', 'prompt', 'tool', 'tool', 'tool', 'agent', 'reply', 'prompt', 'reply'
    ]);
  });

  it('numbers the typed prompts and slash commands with arguments 1..n; meta, bare commands, interruptions, the compaction summary and task notifications are not prompts', () => {
    expect(of(fixture(), 'prompt')).toEqual([
      { k: 'prompt', n: 1, at: ms('2026-10-31T11:38:00.000Z'), text: 'Fix the login bug in three points:\n1. session expiry\n2. refresh token rotation\n3. tests for both' },
      { k: 'prompt', n: 2, at: ms('2026-10-31T11:51:00.000Z'), text: '/review-tools:checklist docs/plan.md' },
      { k: 'prompt', n: 3, at: ms('2026-10-31T11:52:00.000Z'), text: 'Now do point 3: the tests. The CI token is …' },
      { k: 'prompt', n: 4, at: ms('2026-10-31T12:00:00.000Z'), text: 'Thanks, commit it' }
    ]);
  });

  it('keeps the user\'s answer to a question', () => {
    expect(of(fixture(), 'answer')).toEqual([{ k: 'answer', at: ms('2026-10-31T11:46:00.000Z'), text: 'Every use' }]);
  });

  it('a tool call is its name and its project-relative file, the first line of its command, its pattern or its description', () => {
    expect(of(fixture(), 'tool').map((e) => e.line)).toEqual([
      'Read src/auth/session.ts', 'Edit src/auth/session.ts', 'Bash npm test -- auth', 'Agent Review the session fix', 'Edit src/auth/refresh.ts',
      'Write /elsewhere/notes/auth.md', 'Grep refreshToken in src', 'Bash cd /p/app && npm run build', 'Agent Run the e2e suite'
    ]);
    expect(of(fixture(), 'tool')[0]).toEqual({ k: 'tool', at: ms('2026-10-31T11:39:06.000Z'), line: 'Read src/auth/session.ts' });
  });

  it('leaves tool outputs, inputs, thinking, sidechains and Claude Code\'s own messages out', () => {
    const all = JSON.stringify(fixture());
    for (const s of ['READ-OUTPUT', 'EDIT-OUTPUT', 'GREP-OUTPUT', 'BASH-OUTPUT', 'Tests: 12 passed', 'wJalrXUtnFEMI', 'WRITE-CONTENT', 'AGENT-PROMPT',
      'THINKING-TEXT', 'SIDECHAIN-TEXT', 'SUMMARY-TEXT', 'Async agent launched', 'Caveat', 'Set model to opus', 'Request interrupted', 'User has approved',
      '/model', 'SKILL-EXPANSION', 'You can now continue']) {
      expect(all).not.toContain(s);
    }
  });

  it('keeps an Agent result, foreground or background, cut to AGENT_MAX with its head and tail and without its metadata', () => {
    const [fg, bg] = of(fixture(), 'agent');
    expect(fg!.at).toBe(ms('2026-10-31T11:44:00.000Z'));
    expect(fg!.text.length).toBeLessThanOrEqual(AGENT_MAX);
    expect(fg!.text.startsWith('REPORT-HEAD: review of src/auth/session.ts')).toBe(true);
    expect(fg!.text).toContain('REPORT-TAIL: verdict ok, tests green');
    expect(fg!.text).toMatch(/\[… \d+ characters cut …\]/);
    expect(fg!.text).not.toContain('agentId: a7c1e2f');
    expect(fg!.text).not.toContain('<usage>');
    expect(fg!.text).not.toContain('sk-ant-api03');
    expect(bg).toEqual({ k: 'agent', at: ms('2026-10-31T11:58:00.000Z'), text: 'E2E: 42 passed, 0 failed. The login flow is green.' });
  });

  it('keeps the question asked with its options, the proposed plan, the replies and the compaction', () => {
    const e = fixture();
    expect(of(e, 'question')).toEqual([{ k: 'question', at: ms('2026-10-31T11:45:00.000Z'), text: 'Should the refresh token rotate on every use or once a day? (Every use / Once a day)' }]);
    expect(of(e, 'reply').map((r) => r.text)).toEqual([
      'Plan:\n## Plan\n1. Make the session expire after 30 minutes\n2. Rotate the refresh token on use\n3. Add tests for both',
      "I'll start with the session module.",
      'Auth tests pass. Heads-up: a test fixture prints the key …; rotate it.',
      'Point 3 done: tests for expiry and rotation are in, unit and e2e green.',
      'Committed as 3f2a9c1.'
    ]);
    expect(of(e, 'compact')).toEqual([{ k: 'compact', at: ms('2026-10-31T11:50:00.000Z') }]);
  });

  it('each TodoWrite is the whole list at that time', () => {
    const todos = of(fixture(), 'todos');
    expect(todos).toHaveLength(3);
    expect(todos[2]).toEqual({ k: 'todos', at: ms('2026-10-31T11:47:30.000Z'), items: [
      { text: 'Session expiry', status: 'completed' }, { text: 'Refresh token rotation', status: 'completed' }, { text: 'Tests for both', status: 'in_progress' }
    ] });
  });
});

describe('chatEntries on single lines', () => {
  it('TaskCreate and TaskUpdate keep the task list (created on their result, updated, deleted)', () => {
    const st = fresh();
    const run = (l: unknown) => chatEntries(l, ROOT, st);
    expect(run(use('t1', 'TaskCreate', { subject: 'Write the spec', description: 'All of it' }))).toEqual([]);
    expect(run(result('t1', 'Task #1 created successfully: Write the spec', { toolUseResult: { task: { id: '1', subject: 'Write the spec' } } })))
      .toEqual([{ k: 'todos', at: ms(T), items: [{ text: 'Write the spec', status: 'pending' }] }]);
    run(use('t2', 'TaskCreate', { subject: 'Build it', description: '' }));
    expect(run(result('t2', [{ type: 'text', text: 'Task #2 created successfully: Build it' }]))).toEqual([{ k: 'todos', at: ms(T), items: [
      { text: 'Write the spec', status: 'pending' }, { text: 'Build it', status: 'pending' }
    ] }]);
    expect(run(use('t3', 'TaskUpdate', { taskId: '1', status: 'completed' }))).toEqual([{ k: 'todos', at: ms(T), items: [
      { text: 'Write the spec', status: 'completed' }, { text: 'Build it', status: 'pending' }
    ] }]);
    expect(run(use('t4', 'TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Build and ship it' }))[0]).toMatchObject({ items: [
      { text: 'Write the spec', status: 'completed' }, { text: 'Build and ship it', status: 'in_progress' }
    ] });
    expect(run(use('t5', 'TaskUpdate', { taskId: '1', status: 'deleted' }))[0]).toMatchObject({ items: [{ text: 'Build and ship it', status: 'in_progress' }] });
    expect(run(use('t6', 'TaskList', {}))).toEqual([]);
    expect(run(use('t7', 'TaskGet', { taskId: '2' }))).toEqual([]);
  });

  it('paths: inside the project relative (the root itself "."), outside absolute, long ones cut at the front', () => {
    const line = (input: Record<string, unknown>, name = 'Read', root = ROOT) => (chatEntries(use('x', name, input), root, fresh())[0] as { line: string }).line;
    expect(line({ file_path: '/p/app' })).toBe('Read .');
    expect(line({ file_path: '/p/app-other/a.ts' })).toBe('Read /p/app-other/a.ts');
    expect(line({ file_path: '/p/app/a.ts' }, 'Read', '/p/app/')).toBe('Read a.ts');
    expect(line({ file_path: '/p/app/a.ts' }, 'Read', '')).toBe('Read /p/app/a.ts');
    expect(line({ notebook_path: '/p/app/nb/x.ipynb' }, 'NotebookEdit')).toBe('NotebookEdit nb/x.ipynb');
    const deep = `/p/app/${'folder/'.repeat(40)}deep.ts`;
    const cut = line({ file_path: deep });
    expect(cut.length).toBeLessThanOrEqual('Read '.length + 160);
    expect(cut.startsWith('Read …')).toBe(true);
    expect(cut.endsWith('/folder/deep.ts')).toBe(true);
  });

  it('Windows: the transcript\'s C:\\… paths against main\'s C:/… root, any case, relative with forward slashes as on macOS', () => {
    const line = (input: Record<string, unknown>, name = 'Edit') => (chatEntries(use('x', name, input), 'C:/dev/proj [v2] (1)', fresh())[0] as { line: string }).line;
    try {
      initPlatform('win32');
      expect(line({ file_path: 'C:\\dev\\proj [v2] (1)\\src\\auth\\session.ts' })).toBe('Edit src/auth/session.ts');
      expect(line({ file_path: 'c:\\DEV\\proj [v2] (1)\\src\\a.ts' }, 'Read')).toBe('Read src/a.ts');
      expect(line({ pattern: 'refreshToken', path: 'C:\\dev\\proj [v2] (1)\\src' }, 'Grep')).toBe('Grep refreshToken in src');
      expect(line({ file_path: 'C:\\dev\\proj [v2] (1)' }, 'Read')).toBe('Read .');
      expect(line({ file_path: 'C:\\elsewhere\\notes.md' }, 'Write')).toBe('Write C:\\elsewhere\\notes.md');
    } finally { resetPlatformForTests(); }
  });

  it('commands: the first line, cut to 160, token-like runs redacted before the cut; other tools by url, query or name', () => {
    const line = (name: string, input: Record<string, unknown>) => (chatEntries(use('x', name, input), ROOT, fresh())[0] as { line: string }).line;
    expect(line('Bash', { command: `curl -H "Authorization: Bearer sk-ant-api03-${'A1b2'.repeat(10)}" https://x.test` })).toBe('Bash curl -H "Authorization: Bearer …" https://x.test');
    const long = line('Bash', { command: `echo ${'word '.repeat(80)}` });
    expect(long.length).toBeLessThanOrEqual('Bash '.length + 160);
    expect(long.endsWith('…')).toBe(true);
    expect(line('Glob', { pattern: 'src/**/*.ts' })).toBe('Glob src/**/*.ts');
    expect(line('WebFetch', { url: 'https://example.com/docs', prompt: 'Summarise' })).toBe('WebFetch https://example.com/docs');
    expect(line('WebSearch', { query: 'vitest mocks' })).toBe('WebSearch vitest mocks');
    expect(line('Task', { description: 'Old name of Agent', prompt: 'p' })).toBe('Task Old name of Agent');
    expect(line('mcp__notion__notion-search', {})).toBe('mcp__notion__notion-search');
  });

  it('agent results: string or blocks, errors kept; launches, unknown ids and other tools\' results dropped', () => {
    const st = fresh();
    const run = (l: unknown) => chatEntries(l, ROOT, st);
    run(use('a1', 'Task', { description: 'd' }));
    expect(run(result('a1', 'Done: all green'))).toEqual([{ k: 'agent', at: ms(T), text: 'Done: all green' }]);
    run(use('a2', 'Agent', { description: 'd' }));
    expect(run({ ...result('a2', [{ type: 'text', text: 'Agent failed: context limit' }]), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a2', is_error: true, content: [{ type: 'text', text: 'Agent failed: context limit' }] }] } }))
      .toEqual([{ k: 'agent', at: ms(T), text: 'Agent failed: context limit' }]);
    run(use('a3', 'Agent', { description: 'd', run_in_background: true }));
    expect(run(result('a3', 'Launched.', { toolUseResult: { status: 'async_launched', agentId: 'x' } }))).toEqual([]);
    expect(run(result('a1', 'Second result for a closed id'))).toEqual([]);
    expect(run(result('zz', 'Unknown'))).toEqual([]);
    run(use('b1', 'Bash', { command: 'ls' }));
    expect(run(result('b1', 'SECRET-LISTING'))).toEqual([]);
  });

  it('a task notification without a result (a background shell) is nothing; prompts starting with a tag are Claude Code\'s', () => {
    const st = fresh();
    expect(chatEntries(prompt('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>'), ROOT, st)).toEqual([]);
    expect(chatEntries(prompt('<scheduled-task name="x">check the build</scheduled-task>'), ROOT, st)).toEqual([]);
    expect(chatEntries({ ...prompt('Hello'), isSidechain: true }, ROOT, st)).toEqual([]);
    expect(chatEntries(null, ROOT, st)).toEqual([]);
    expect(chatEntries('text', ROOT, st)).toEqual([]);
    expect(chatEntries({ type: 'user', message: { content: 'No time' } }, ROOT, st)).toEqual([{ k: 'prompt', n: 1, at: null, text: 'No time' }]);
    expect(st.prompts).toBe(1);
  });

  it('answers to AskUserQuestion: from the structured result, else from its text; short, redacted; a rejected one is nothing', () => {
    const st = fresh();
    const run = (l: unknown) => chatEntries(l, ROOT, st);
    const ask = (id: string, questions: string[]) => use(id, 'AskUserQuestion', { questions: questions.map((question) => ({ question, header: 'H', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] })) });
    run(ask('q1', ['Which one?', 'And the name?']));
    expect(run(result('q1', 'User has answered your questions: ...', { toolUseResult: { questions: [], answers: { 'Which one?': 'A', 'And the name?': `call it ghp_${'Zz9'.repeat(10)}` } } })))
      .toEqual([{ k: 'answer', at: ms(T), text: 'Which one? → A / And the name? → call it …' }]);
    run(ask('q2', ['Rotate daily?']));
    expect(run(result('q2', 'User has answered your questions: "Rotate daily?"="No, on every use". You can now continue with the user\'s answers in mind.')))
      .toEqual([{ k: 'answer', at: ms(T), text: 'No, on every use' }]);
    run(ask('q3', ['Long?']));
    const [long] = run(result('q3', 'x', { toolUseResult: { answers: { 'Long?': 'w '.repeat(2000) } } })) as { text: string }[];
    expect(long!.text.length).toBeLessThanOrEqual(500);
    run(ask('q4', ['Rejected?']));
    expect(run({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q4', is_error: true, content: 'The user doesn\'t want to proceed with this tool use.' }] } })).toEqual([]);
    run(ask('q5', ['Nothing?']));
    expect(run(result('q5', 'Something else entirely'))).toEqual([]);
  });

  it('slash commands with arguments are numbered prompts; bare commands, their output and unknown names are not', () => {
    const st = fresh();
    const run = (text: string) => chatEntries(prompt(text), ROOT, st);
    expect(run('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 42, focus on auth</command-args>'))
      .toEqual([{ k: 'prompt', n: 1, at: ms(T), text: '/review PR 42, focus on auth' }]);
    expect(run('<command-message>deploy</command-message>\n<command-name>deploy</command-name>\n<command-args>staging with ghp_' + 'Qq7'.repeat(10) + '</command-args>'))
      .toEqual([{ k: 'prompt', n: 2, at: ms(T), text: '/deploy staging with …' }]);
    expect(run('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toEqual([]);
    expect(run('<command-name>/compact</command-name>')).toEqual([]);
    expect(run('<command-name>/x y</command-name>\n<command-args>z</command-args>')).toEqual([]);
    expect(run('<local-command-stdout>Set model to opus</local-command-stdout>')).toEqual([]);
    expect(chatEntries({ ...prompt('<command-name>/a</command-name><command-args>b</command-args>'), isMeta: true }, ROOT, st)).toEqual([]);
    expect(st.prompts).toBe(2);
  });

  it('the feedback typed when rejecting a tool is left out (no reader in the codebase knows its shape yet)', () => {
    const st = fresh();
    chatEntries(use('e1', 'Edit', { file_path: '/p/app/a.ts' }), ROOT, st);
    expect(chatEntries({ type: 'user', timestamp: T, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse a map instead' }] } }, ROOT, st)).toEqual([]);
  });

  it('cloneChatState copies what chatEntries changes', () => {
    const st = fresh();
    chatEntries(use('t1', 'TaskCreate', { subject: 'A' }), ROOT, st);
    chatEntries(use('a1', 'Agent', { description: 'd' }), ROOT, st);
    const copy = cloneChatState(st);
    expect(copy).toEqual(st);
    chatEntries(result('t1', 'Task #1 created successfully: A'), ROOT, copy);
    chatEntries(prompt('next'), ROOT, copy);
    expect(st.prompts).toBe(0);
    expect(st.tools).toEqual({ t1: 'TaskCreate', a1: 'Agent' });
    expect(st.tasks).toEqual({ items: {}, pending: { t1: 'A' } });
  });

  it('long prompts and replies keep their head and tail', () => {
    const big = `HEAD ${'x'.repeat(200_000)} TAIL`;
    const [p] = chatEntries(prompt(big), ROOT, fresh()) as { text: string }[];
    expect(p!.text.length).toBeLessThan(40_000);
    expect(p!.text.startsWith('HEAD ')).toBe(true);
    expect(p!.text.endsWith(' TAIL')).toBe(true);
    const [r] = chatEntries(assistant([{ type: 'text', text: big }]), ROOT, fresh()) as { text: string }[];
    expect(r!.text.length).toBeLessThan(40_000);
    expect(r!.text.endsWith(' TAIL')).toBe(true);
  });
});

describe('renderChat', () => {
  it('one compact, greppable block per entry, oldest first, with the day and only the latest task list', () => {
    const out = renderChat(fixture());
    const lines = out.split('\n');
    expect(lines).toContain(`--- ${day('2026-10-31T11:38:00.000Z')} ---`);
    expect(lines).toContain(`[#1 ${hhmm('2026-10-31T11:38:00.000Z')}] YOU: Fix the login bug in three points:`);
    expect(lines).toContain('  1. session expiry');
    expect(lines).toContain(`[${hhmm('2026-10-31T11:41:00.000Z')}] TOOL Edit src/auth/session.ts`);
    expect(lines).toContain(`[${hhmm('2026-10-31T11:58:30.000Z')}] CLAUDE: Point 3 done: tests for expiry and rotation are in, unit and e2e green.`);
    expect(lines).toContain(`[${hhmm('2026-10-31T11:58:00.000Z')}] AGENT RESULT: E2E: 42 passed, 0 failed. The login flow is green.`);
    expect(lines).toContain(`[${hhmm('2026-10-31T11:45:00.000Z')}] ASKED YOU: Should the refresh token rotate on every use or once a day? (Every use / Once a day)`);
    expect(lines).toContain(`[${hhmm('2026-10-31T11:46:00.000Z')}] YOU ANSWERED: Every use`);
    expect(lines).toContain(`[#2 ${hhmm('2026-10-31T11:51:00.000Z')}] YOU: /review-tools:checklist docs/plan.md`);
    expect(lines).toContain(`[${hhmm('2026-10-31T11:50:00.000Z')}] --- context compacted ---`);
    expect(lines.filter((l) => l.includes('] TODOS:'))).toEqual([`[${hhmm('2026-10-31T11:47:30.000Z')}] TODOS:`]);
    expect(lines).toContain('  [in_progress] Tests for both');
    expect(out).not.toContain('[pending] Tests for both');
    expect(out.indexOf('] YOU: Fix')).toBeLessThan(out.indexOf('[#2 '));
    expect(out.indexOf('[#2 ')).toBeLessThan(out.indexOf('[#3 '));
    // Every entry starts a line with "[" (or the day/notes), continuation lines are indented.
    expect(lines.filter((l) => l !== '' && !/^(\[|---|  |Session chat)/.test(l))).toEqual([]);
  });

  it('never shows a secret, whatever the entry', () => {
    const out = renderChat(fixture());
    for (const s of ['ghp_R4nd0m', 'AKIAIOSFODNN7EXAMPLE', 'sk-ant-api03', 'wJalrXUtnFEMI']) expect(out).not.toContain(s);
    const raw = renderChat([
      { k: 'reply', at: null, text: `key sk-ant-${'Ab1'.repeat(10)}` },
      { k: 'prompt', n: 1, at: null, text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123' },
      { k: 'tool', at: null, line: 'Bash export X=AKIAIOSFODNN7EXAMPLE' },
      { k: 'agent', at: null, text: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${'s'.repeat(20)}` },
      { k: 'question', at: null, text: 'xoxb-1234567890-abcdefghij?' },
      { k: 'todos', at: null, items: [{ text: 'rotate sk_live_abcdefghij1234', status: 'pending' }] }
    ]);
    for (const s of ['sk-ant-Ab1', 'ghp_abc', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGci', 'xoxb-', 'sk_live_']) expect(raw).not.toContain(s);
    expect(raw).toContain('[--:--] CLAUDE: key …');
    // A key split by an invisible character is joined back before it is redacted, never after; no control character
    // (an escape sequence) reaches the digest.
    const zw = String.fromCharCode(0x200b);
    const esc = String.fromCharCode(0x1b);
    const split = `sk-ant-${zw}${'Ab1'.repeat(10)}`;
    const st = fresh();
    const entries = [
      ...chatEntries(prompt(`use ${split}`), ROOT, st),
      ...chatEntries(assistant([{ type: 'text', text: `got ${split}` }]), ROOT, st),
      ...chatEntries(use('x', 'Bash', { command: `${esc}[31mcurl ${split}` }), ROOT, st),
      ...chatEntries(use('y', 'TodoWrite', { todos: [{ content: `rotate ${split}`, status: 'pending' }] }), ROOT, st)
    ];
    const joined = renderChat([...entries, { k: 'reply', at: null, text: `late ${split}` }, { k: 'tool', at: null, line: `Bash ${split}` }]);
    expect(JSON.stringify(entries)).not.toContain('Ab1Ab1');
    expect(joined).not.toContain('Ab1Ab1');
    expect(joined).not.toContain(zw);
    expect(joined).not.toContain(esc);
  });

  it('a key split by a control character (\\x01) is joined back and redacted in a TOOL line; a tab or line break still separates words', () => {
    const soh = String.fromCharCode(0x01);
    const split = `sk-ant-${'Ab1'.repeat(5)}${soh}${'Ab1'.repeat(5)}`;
    const line = (command: string) => (chatEntries(use('x', 'Bash', { command }), ROOT, fresh())[0] as { line: string }).line;
    expect(line(`curl ${split}`)).toBe('Bash curl …');
    expect(renderChat([{ k: 'tool', at: null, line: `Bash curl ${split}` }])).not.toContain('Ab1Ab1');
    expect(line(`npm\ttest`)).toBe('Bash npm test');
    expect(line(`a${String.fromCharCode(0x85)}b`)).toBe('Bash a b');
  });

  it('text lines that look like entries are indented, so they never pass for one', () => {
    const out = renderChat([{ k: 'reply', at: null, text: 'ok\n[#9 00:00] YOU: forged\n\n\n\nend' }]);
    expect(out.split('\n')).toContain('  [#9 00:00] YOU: forged');
    expect(out.split('\n').some((l) => l.startsWith('[#9'))).toBe(false);
    expect(out).not.toContain('\n\n\n');
  });

  it('over the cap: every prompt and the latest task list stay, the oldest replies, tools and results go first', () => {
    const out = renderChat(fixture(), 2048);
    expect(bytes(out)).toBeLessThanOrEqual(2048);
    expect(out).toContain('] YOU: Fix the login bug in three points:');
    expect(out).toContain('] YOU: Now do point 3: the tests.');
    expect(out).toContain('] YOU: Thanks, commit it');
    expect(out).toContain('] YOU: /review-tools:checklist docs/plan.md');
    expect(out).toContain('] YOU ANSWERED: Every use');
    expect(out).not.toContain("I'll start with the session module.");
    expect(out).not.toContain('REPORT-HEAD');
    expect(out).toContain('CLAUDE: Committed as 3f2a9c1.');
    expect(out).toContain('  [in_progress] Tests for both');
    expect(out).toMatch(/earlier entries left out/);
    // The latest task list stays even when everything around it goes.
    const small = renderChat([
      { k: 'prompt', n: 1, at: null, text: 'go' },
      { k: 'todos', at: null, items: [{ text: 'Ship it', status: 'in_progress' }] },
      ...Array.from({ length: 50 }, (_, i): ChatEntry => ({ k: 'reply', at: null, text: `reply ${i} ${'r'.repeat(100)}` }))
    ], 1024);
    expect(bytes(small)).toBeLessThanOrEqual(1024);
    expect(small).toContain('  [in_progress] Ship it');
    expect(small).toContain('reply 49 ');
    expect(small).not.toContain('reply 0 ');
  });

  it('prompts alone over the cap: the longest lose their middle, none is dropped, and the newest activity keeps its share', () => {
    const entries: ChatEntry[] = [
      ...Array.from({ length: 5 }, (_, i): ChatEntry => ({ k: 'prompt', n: i + 1, at: null, text: `short ${i + 1}` })),
      { k: 'reply', at: null, text: 'an old reply' },
      { k: 'prompt', n: 6, at: null, text: `LONG-HEAD ${'y'.repeat(20_000)} LONG-TAIL` },
      { k: 'agent', at: null, text: 'agent report: task 3 done, tests green' },
      { k: 'reply', at: null, text: 'the newest reply' }
    ];
    const out = renderChat(entries, 4096);
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    for (let n = 1; n <= 5; n++) expect(out).toContain(`[#${n} --:--] YOU: short ${n}`);
    expect(out).toContain('[#6 --:--] YOU: LONG-HEAD');
    expect(out).toContain('LONG-TAIL');
    expect(out).toMatch(/\[… \d+ characters cut …\]/);
    expect(out).toContain('[--:--] AGENT RESULT: agent report: task 3 done, tests green');
    expect(out).toContain('[--:--] CLAUDE: the newest reply');
    // Prompts lose no more than the rest needs: the chat fills its cap.
    expect(bytes(out)).toBeGreaterThan(4096 * 0.9);
    // Many long prompts and much activity: the prompts get two thirds, the newest replies, tool lines and results a third.
    const busy: ChatEntry[] = [
      ...Array.from({ length: 40 }, (_, i): ChatEntry[] => [
        { k: 'prompt', n: i + 1, at: null, text: `prompt ${i + 1} ${'p'.repeat(1000)}` },
        { k: 'tool', at: null, line: `Edit file-${i}.ts` },
        { k: 'reply', at: null, text: `reply ${i} ${'r'.repeat(400)}` }
      ]).flat(),
      { k: 'agent', at: null, text: 'LAST-AGENT done' }
    ];
    const out3 = renderChat(busy, 32_768);
    expect(bytes(out3)).toBeLessThanOrEqual(32_768);
    for (let n = 1; n <= 40; n++) expect(out3).toContain(`[#${n} --:--] YOU: prompt ${n} `);
    expect(out3).toContain('AGENT RESULT: LAST-AGENT done');
    expect(out3).toContain('CLAUDE: reply 39 ');
    expect(out3).toContain('TOOL Edit file-39.ts');
    expect(out3).not.toContain('CLAUDE: reply 0 ');
    const recent = out3.split('\n').filter((l) => /^\[--:--\] (CLAUDE|TOOL|AGENT)/.test(l)).join('\n');
    expect(bytes(recent)).toBeGreaterThan(32_768 / 4);
    // Prompts already at their shortest still leave the newest activity its third (the cap gives way, not the activity).
    const crowded: ChatEntry[] = [
      ...Array.from({ length: 60 }, (_, i): ChatEntry => ({ k: 'prompt', n: i + 1, at: null, text: `prompt ${i + 1} ${'p'.repeat(1000)}` })),
      ...busy.filter((e) => e.k !== 'prompt')
    ];
    const out4 = renderChat(crowded, 16_384);
    for (let n = 1; n <= 60; n++) expect(out4).toContain(`[#${n} --:--] YOU: prompt ${n} `);
    expect(out4).toContain('AGENT RESULT: LAST-AGENT done');
    expect(out4).toContain('CLAUDE: reply 39 ');
    const recent4 = out4.split('\n').filter((l) => /^\[--:--\] (CLAUDE|TOOL|AGENT)/.test(l)).join('\n');
    expect(bytes(recent4)).toBeGreaterThan(16_384 / 4);
    // Many long prompts of the same size are cut alike.
    const same = Array.from({ length: 10 }, (_, i): ChatEntry => ({ k: 'prompt', n: i + 1, at: null, text: `P${i + 1}-HEAD ${'é'.repeat(3000)} P${i + 1}-TAIL` }));
    const out2 = renderChat(same, 16_384);
    expect(bytes(out2)).toBeLessThanOrEqual(16_384);
    for (let n = 1; n <= 10; n++) { expect(out2).toContain(`P${n}-HEAD`); expect(out2).toContain(`P${n}-TAIL`); }
  });

  it('cuts never split a character', () => {
    const wellFormed = (s: string) => Buffer.from(s, 'utf8').toString('utf8') === s;
    const emoji = '😀'.repeat(20_000);
    // An odd character before or after shifts every cut point by one code unit.
    for (const [pre, post] of [['', ''], ['x', ''], ['', 'y'], ['x', 'y']] as const) {
      const [p] = chatEntries(prompt(`${pre}${emoji}${post}`), ROOT, fresh()) as { text: string }[];
      expect(wellFormed(p!.text)).toBe(true);
      const [t] = chatEntries(use('x', 'Read', { file_path: `/elsewhere/${pre}${'📁'.repeat(200)}${post}` }), ROOT, fresh()) as { line: string }[];
      expect(wellFormed(t!.line)).toBe(true);
      const [b] = chatEntries(use('x', 'Bash', { command: `${pre}${'🚀'.repeat(200)}${post}` }), ROOT, fresh()) as { line: string }[];
      expect(wellFormed(b!.line)).toBe(true);
      const out = renderChat([{ k: 'prompt', n: 1, at: null, text: `${pre}${emoji}${post}` }], 4096);
      expect(wellFormed(out)).toBe(true);
      expect(bytes(out)).toBeLessThanOrEqual(4096);
    }
  });

  it('stays under CHAT_CAP by default', () => {
    const many = Array.from({ length: 2000 }, (_, i): ChatEntry => ({ k: 'reply', at: null, text: `reply ${i} ${'z'.repeat(1000)}` }));
    const out = renderChat([{ k: 'prompt', n: 1, at: null, text: 'go' }, ...many]);
    expect(bytes(out)).toBeLessThanOrEqual(CHAT_CAP);
    expect(out).toContain('YOU: go');
    expect(out).toContain('reply 1999 ');
    expect(out).not.toContain('reply 0 ');
  });

  it('a day line where the date changes; consecutive compactions show once', () => {
    const d1 = '2026-10-30T09:00:00.000Z';
    const d2 = '2026-11-02T09:00:00.000Z';
    const out = renderChat([
      { k: 'prompt', n: 1, at: ms(d1), text: 'first' },
      { k: 'compact', at: ms(d1) },
      { k: 'compact', at: ms(d1) },
      { k: 'prompt', n: 2, at: ms(d2), text: 'second' }
    ]);
    const lines = out.split('\n');
    expect(lines.filter((l) => l.startsWith('--- 20'))).toEqual([`--- ${day(d1)} ---`, `--- ${day(d2)} ---`]);
    expect(lines.filter((l) => l.includes('context compacted'))).toHaveLength(1);
  });

  it('nothing yet: just the header', () => {
    expect(renderChat([]).trim().split('\n')).toHaveLength(1);
  });
});

describe('pruneChat', () => {
  /** Deterministic lists with every kind, several days, missing times, runs of compactions and many task lists. */
  function list(seed: number, n: number): ChatEntry[] {
    let s = seed >>> 0;
    const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
    const out: ChatEntry[] = [];
    let prompts = 0;
    let t = ms('2026-10-28T08:00:00.000Z');
    for (let i = 0; i < n; i++) {
      t += Math.floor(r() * 3 * 3600_000);
      const at = r() < 0.05 ? null : t;
      const x = r();
      const text = (w: string) => `${w} ${i} ${'w'.repeat(Math.floor(r() * 600))}`;
      if (x < 0.1) out.push({ k: 'prompt', n: ++prompts, at, text: text('prompt') });
      else if (x < 0.35) out.push({ k: 'reply', at, text: text('reply') });
      else if (x < 0.6) out.push({ k: 'tool', at, line: `Edit f${i}.ts` });
      else if (x < 0.7) out.push({ k: 'agent', at, text: text('agent') });
      else if (x < 0.75) out.push({ k: 'question', at, text: text('question') });
      else if (x < 0.8) out.push({ k: 'answer', at, text: `answer ${i}` });
      else if (x < 0.9) out.push({ k: 'todos', at, items: [{ text: `todo ${i}`, status: 'pending' }] });
      else out.push({ k: 'compact', at });
    }
    return out;
  }
  const own = (e: ChatEntry[]) => e.filter((x) => x.k === 'prompt' || x.k === 'answer');

  it('drops only what renderChat can never show: the same chat.md, every prompt and answer kept', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const entries = list(seed, 400);
      for (const cap of [1024, 4096, 20_000, CHAT_CAP]) {
        const pruned = pruneChat(entries, cap);
        expect(renderChat(pruned, cap), `seed ${seed}, cap ${cap}`).toBe(renderChat(entries, cap));
        expect(own(pruned)).toEqual(own(entries));
        expect(pruneChat(pruned, cap)).toEqual(pruned);
      }
    }
  });

  it('drops the task lists before the latest and repeated compactions', () => {
    const entries: ChatEntry[] = [
      { k: 'prompt', n: 1, at: null, text: 'go' },
      ...Array.from({ length: 1000 }, (_, i): ChatEntry => ({ k: 'todos', at: null, items: [{ text: `step ${i}`, status: 'pending' }] })),
      { k: 'compact', at: null },
      { k: 'compact', at: null },
      { k: 'reply', at: null, text: 'done' }
    ];
    const pruned = pruneChat(entries);
    expect(pruned.map((e) => e.k)).toEqual(['prompt', 'todos', 'compact', 'reply']);
    expect(pruned[1]).toEqual(entries[1000]);
    expect(renderChat(pruned)).toBe(renderChat(entries));
  });

  it('keeps the other entries to about one cap of the newest', () => {
    const entries: ChatEntry[] = [
      { k: 'prompt', n: 1, at: null, text: 'go' },
      ...Array.from({ length: 5000 }, (_, i): ChatEntry => ({ k: 'reply', at: null, text: `reply ${i} ${'z'.repeat(1000)}` }))
    ];
    const pruned = pruneChat(entries);
    const others = pruned.filter((e) => e.k !== 'prompt');
    expect(others.length).toBeLessThanOrEqual(Math.ceil(CHAT_CAP / 1000) + 1);
    expect(others.at(-1)).toEqual(entries.at(-1));
    expect(renderChat(pruned)).toBe(renderChat(entries));
  });
});
