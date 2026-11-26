import { describe, expect, test } from 'vitest';
import { reduceHook } from '../session';
import { toolCall, toolDone, waitTargetOf } from './tools';

const AT = { root: '/work/app', home: '/home/uuuuuuuu' };

/** The activity atelierd writes while the session waits on this request, without its "waiting: " lead. */
function activityOf(tool: string, input: Record<string, unknown>): string {
  const s0 = reduceHook(null, { hook_event_name: 'SessionStart', session_id: 's1' }, 1)!;
  const s = reduceHook(s0, { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: tool, tool_input: input }, 2)!;
  return /^waiting: (.*)$/.exec(s.activity ?? '')![1]!;
}

describe('waitTargetOf', () => {
  test('waitTargetOf gives the target atelierd puts in a waiting session\'s activity', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Bash', { command: 'npm   test --\n  --run   src/some/very/long/path/that/goes/on/and/on.test.ts  --reporter=verbose' }],
      ['Bash', { command: 'ls' }],
      ['Edit', { file_path: '/work/app/src/a.ts', old_string: 'x', new_string: 'y' }],
      ['NotebookEdit', { notebook_path: '/work/app/n.ipynb' }],
      ['ExitPlanMode', { plan: '# Plan' }],
      ['AskUserQuestion', { questions: [] }],
      ['mcp__github__get_issue', { number: 4 }]
    ];
    for (const [tool, input] of cases) expect(waitTargetOf(tool, input)).toBe(activityOf(tool, input));
    expect(waitTargetOf('ExitPlanMode', {})).toBe('plan approval');
    expect(waitTargetOf('AskUserQuestion', {})).toBe('question');
    expect(waitTargetOf('Bash', { command: 'a   b' })).toBe('Bash a b');
  });
});

describe('toolCall', () => {
  test('targets: a path relative to the project, ~/ under home, absolute elsewhere; a command\'s first line', () => {
    expect(toolCall('Read', { file_path: '/work/app/src/a.ts' }, AT)).toMatchObject({ tool: 'Read', target: 'src/a.ts' });
    expect(toolCall('Read', { file_path: '/home/uuuuuuuu/.config/x' }, AT).target).toBe('~/.config/x');
    expect(toolCall('Read', { file_path: '/etc/hosts' }, AT).target).toBe('/etc/hosts');
    expect(toolCall('Bash', { command: 'echo a\necho b' }, AT).target).toBe('echo a');
    expect(toolCall('Grep', { pattern: 'foo', path: '/work/app/src' }, AT).target).toBe('foo in src');
    expect(toolCall('mcp__x__y', {}, AT)).toEqual({ tool: 'mcp__x__y' });
  });

  test('a running Edit shows its diff from the call; MultiEdit every edit; Write the head of its content', () => {
    expect(toolCall('Edit', { file_path: '/work/app/a', old_string: 'a\nb', new_string: 'c' }, AT).detail).toBe('-a\n-b\n+c');
    expect(toolCall('MultiEdit', { file_path: '/work/app/a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }, AT).detail).toBe('-a\n+b\n-c\n+d');
    const write = toolCall('Write', { file_path: '/work/app/a', content: Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n') }, AT).detail!;
    expect(write.split('\n')).toHaveLength(80);
    expect(write.startsWith('+l0\n+l1')).toBe(true);
  });

  test('ExitPlanMode carries the plan as its detail, up to 16 KiB', () => {
    expect(toolCall('ExitPlanMode', { plan: '# Plan\n1. x' }, AT)).toEqual({ tool: 'ExitPlanMode', detail: '# Plan\n1. x' });
    expect(toolCall('ExitPlanMode', { plan: 'p'.repeat(40000) }, AT).detail!.length).toBeLessThanOrEqual(16384);
  });
});

describe('toolDone', () => {
  const done = (name: string, input: Record<string, unknown>, content: unknown, result: unknown, isError = false, line: Record<string, unknown> = {}) =>
    toolDone(name, input, content, result, isError, line);

  test('Bash: line count, no output, background; detail the output tail', () => {
    expect(done('Bash', {}, 'a\nb', { stdout: 'a\nb', stderr: '' })).toEqual({ status: 'ok', summary: '2 lines', detail: 'a\nb' });
    expect(done('Bash', {}, '(Bash completed with no output)', { stdout: '', stderr: '', noOutputExpected: true })).toEqual({ status: 'ok', summary: 'No output' });
    expect(done('Bash', {}, 'Command running in background', { stdout: '', stderr: '', backgroundTaskId: 'b1' })).toEqual({ status: 'running', summary: 'In background' });
  });

  test('Edit: "+A −R" and the structured patch as detail', () => {
    const r = { structuredPatch: [{ lines: ['-Hello, world!', '+Hello, there!', ' tail'] }] };
    expect(done('Edit', {}, 'updated', r)).toEqual({ status: 'ok', summary: '+1 −1', detail: '-Hello, world!\n+Hello, there!\n tail' });
  });

  test('Read, Write, Grep, Glob, other tools and ExitPlanMode', () => {
    expect(done('Read', {}, 'x', { file: { numLines: 3 } })).toEqual({ status: 'ok', summary: '3 lines' });
    expect(done('Write', { content: 'a\nb\nc' }, 'created', { content: 'a\nb\nc' })).toMatchObject({ status: 'ok', summary: '3 lines' });
    expect(done('Grep', {}, 'x', { numFiles: 4 }).summary).toBe('4 files');
    expect(done('Grep', {}, 'x', { mode: 'count', numMatches: 1 }).summary).toBe('1 match');
    expect(done('Glob', {}, 'a\nb', {}).summary).toBe('2 lines');
    expect(done('WebFetch', {}, [{ type: 'text', text: 'one\ntwo\nthree' }], null)).toEqual({ status: 'ok', summary: '3 lines', detail: 'one\ntwo\nthree' });
    expect(done('mcp__x__y', {}, '', null)).toEqual({ status: 'ok', summary: 'Done' });
    expect(done('ExitPlanMode', {}, 'User has approved your plan', { plan: 'p' })).toEqual({ status: 'ok', summary: 'Approved' });
  });

  test('errors: interrupted, rejected with feedback, and a failure with its first line and text', () => {
    expect(done('Bash', {}, 'The user doesn\'t want to proceed', 'User rejected tool use', true)).toEqual({ status: 'error', summary: 'Interrupted' });
    expect(done('Bash', {}, 'The user doesn\'t want to proceed. the user said:\nno', 'Error: x', true, { userFeedback: 'no' })).toEqual({ status: 'error', summary: 'Rejected', feedback: 'no' });
    expect(done('Bash', {}, '<tool_use_error>Blocked: sleep\nmore</tool_use_error>', 'Error: x', true)).toEqual({ status: 'error', summary: 'Blocked: sleep', detail: 'Blocked: sleep\nmore' });
  });
});

describe('toolDone edge cases', () => {
  const done = (name: string, content: unknown, result: unknown, isError = false) => toolDone(name, {}, content, result, isError, {});
  const fast = (f: () => unknown) => { const t = performance.now(); f(); expect(performance.now() - t).toBeLessThan(250); };

  test('long runs of whitespace in a result or an error are handled in linear time', () => {
    const spaces = `a${' '.repeat(65000)}b`;
    const newlines = `a${'\n'.repeat(65000)}b`;
    fast(() => done('Bash', spaces, { stdout: spaces, stderr: '' }));
    fast(() => done('Bash', newlines, { stdout: newlines, stderr: '' }));
    fast(() => done('Read', 'x', {}, true));
    fast(() => done('Bash', `<tool_use_error>${' '.repeat(30000)}x${' '.repeat(30000)}`, 'Error: x', true));
    fast(() => done('Bash', `<tool_use_error>${' '.repeat(30000)}x</tool_use_error>`, 'Error: x', true));
    expect(done('Bash', '<tool_use_error>bad  </tool_use_error>', 'Error: x', true)).toEqual({ status: 'error', summary: 'bad', detail: 'bad' });
  });

  test('an error keeps the end of its text: the last 20 lines, within 2 KiB', () => {
    const body = Array.from({ length: 1000 }, (_, i) => (i === 999 ? 'LAST' : 'x')).join('\n');
    const e = done('Bash', body, 'Error: x', true);
    expect(e.detail!.endsWith('LAST')).toBe(true);
    expect(e.detail!.split('\n')).toHaveLength(20);
    expect(e.summary).toBe('x');
  });

  test('Grep and Glob summaries follow the result\'s mode (hand-made shapes: no real Grep recording exists yet)', () => {
    expect(done('Grep', 'x', { mode: 'content', numFiles: 0, numLines: 12, content: 'a\nb' }).summary).toBe('12 lines');
    expect(done('Grep', 'a\nb\nc', { mode: 'content', numFiles: 0 }).summary).toBe('3 lines');
    expect(done('Grep', 'x', { mode: 'count', numFiles: 3, numMatches: 17 }).summary).toBe('17 matches');
    expect(done('Grep', 'x', { mode: 'files_with_matches', numFiles: 4 }).summary).toBe('4 files');
    expect(done('Glob', 'x', { numFiles: 1 }).summary).toBe('1 file');
    expect(done('Grep', 'x', { numFiles: 2 }).summary).toBe('2 files');
  });

  test('a Bash result that says no output was expected still shows the output it has', () => {
    expect(done('Bash', 'x', { stdout: 'x', stderr: '', noOutputExpected: true })).toMatchObject({ summary: '1 line', detail: 'x' });
  });

  test('a long target is cut to 160 characters', () => {
    expect(toolCall('Bash', { command: 'x'.repeat(500) }, AT).target!.length).toBeLessThanOrEqual(160);
    expect(toolCall('Read', { file_path: `/work/app/${'d/'.repeat(200)}f.ts` }, AT).target!.length).toBeLessThanOrEqual(160);
  });
});

describe('a secret cut by an early cut', () => {
  /** A run redaction turns into "…": long hex, so text before or after a cut shrinks to almost nothing. */
  const HEX = 'a1'.repeat(320);
  const KEY = `ghp_${'Zq9Xw8Vu7Ts6Rq5Po4Nm'.repeat(2)}`;
  /** Hex runs and spaces, `n` characters. */
  const filler = (n: number) => `${HEX} `.repeat(Math.ceil(n / (HEX.length + 1))).slice(0, n);
  const leaks = (s: string | undefined) => [KEY.slice(0, 8), KEY.slice(4, 12), KEY.slice(-8)].some((p) => s?.includes(p));

  test('a Write\'s content: a token split by the first cut shows no piece of itself', () => {
    // The token begins 19 characters before the content's first cut (8192): its piece is too short to look like one.
    const content = `${filler(8192 - 20)} ${KEY} ${filler(2000)}`;
    const detail = toolCall('Write', { file_path: '/work/app/a.txt', content }, AT).detail;
    expect(detail).toBeDefined();
    expect(leaks(detail)).toBe(false);
  });

  test('a command\'s output: a token split by the tail\'s cut shows no piece of itself', () => {
    // The last 64 KiB begin 25 characters before the token's end.
    const out = `${filler(1000)} ${KEY} ${filler(65536 - 26)}`;
    const done = toolDone('Bash', { command: 'cat .env' }, '', { stdout: out, stderr: '' }, false, {});
    expect(done.detail).toBeDefined();
    expect(leaks(done.detail)).toBe(false);
  });

  test('a command or a label cut before its redaction (Ask\'s short values too): no piece of a token', () => {
    const command = `${filler(4096 - 20)} ${KEY}`;
    const call = toolCall('Bash', { command }, AT);
    expect(leaks(call.target)).toBe(false);
  });
});
