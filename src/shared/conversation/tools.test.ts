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
    expect(done('Bash', {}, 'Command running in background', { stdout: '', stderr: '', backgroundTaskId: 'b1' })).toEqual({ status: 'ok', summary: 'In background' });
  });

  test('Edit: "+A −R" and the structured patch as detail', () => {
    const r = { structuredPatch: [{ lines: ['-Hello, world!', '+Hello, there!', ' tail'] }] };
    expect(done('Edit', {}, 'updated', r)).toEqual({ status: 'ok', summary: '+1 −1', detail: '-Hello, world!\n+Hello, there!\n tail' });
  });

  test('Read, Write, Grep, Glob, other tools and ExitPlanMode', () => {
    expect(done('Read', {}, 'x', { file: { numLines: 3 } })).toEqual({ status: 'ok', summary: '3 lines' });
    expect(done('Write', { content: 'a\nb\nc' }, 'created', { content: 'a\nb\nc' })).toMatchObject({ status: 'ok', summary: '3 lines' });
    expect(done('Grep', {}, 'x', { numFiles: 4 }).summary).toBe('4 files');
    expect(done('Grep', {}, 'x', { numMatches: 1 }).summary).toBe('1 match');
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
