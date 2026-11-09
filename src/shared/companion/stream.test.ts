import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStreamLine, traceLine, within, type StreamItem } from './stream';

function load(name: string): StreamItem[] {
  return readFileSync(`tests/fixtures/companion/${name}.jsonl`, 'utf8').split('\n')
    .flatMap((l) => parseStreamLine(l));
}
const roots = { project: '/p/app', thread: '/h/c/S' };

describe('parseStreamLine', () => {
  it('concatenated deltas equal the result text', () => {
    const items = load('stream-question');
    const text = items.filter((i) => i.t === 'delta').map((i) => (i as { text: string }).text).join('');
    const result = items.find((i) => i.t === 'result') as Extract<StreamItem, { t: 'result' }>;
    expect(text).toBe(result.text);
    expect(result.costUsd).toBe(0.00166288);
    expect(result.apiStatus).toBeNull();
    expect(items[0]).toEqual({ t: 'init', sessionId: '440824c5-f4da-4c78-9a14-51d6b671129c' });
    expect(items.find((i) => i.t === 'rate')).toEqual({ t: 'rate', status: 'allowed', resetsAt: 1793455200, window: 'five-hour' });
  });
  it('yields tool items from assistant events only, never StructuredOutput', () => {
    const tools = load('stream-question').filter((i) => i.t === 'tool') as Extract<StreamItem, { t: 'tool' }>[];
    expect(tools.map((t) => t.name)).toEqual(['Read', 'Grep', 'Read', 'Grep']);
    expect(tools.map((t) => t.id)).toEqual(['toolu_011e', 'toolu_02g', 'toolu_03a', 'toolu_03b']);
    expect(tools[0]?.input).toEqual({ file_path: '/p/app/src/token-store.ts' });
  });
  it('keeps the structured output of the result', () => {
    const r = load('stream-catchup').find((i) => i.t === 'result') as Extract<StreamItem, { t: 'result' }>;
    expect(r.structured).toEqual({ points: ['Sessions are named'], where: 'chat', choices: [] });
  });
  it('reports permission denials', () => {
    expect(load('stream-catchup').find((i) => i.t === 'denied')).toEqual({ t: 'denied', tool: 'Read', reason: '--restricted: path outside the working directory' });
  });
  it('reads the limit state', () => {
    const items = load('stream-limit');
    expect(items.find((i) => i.t === 'rate')).toEqual({ t: 'rate', status: 'rejected', resetsAt: 1793455200, window: 'five-hour' });
    const r = items.find((i) => i.t === 'result') as Extract<StreamItem, { t: 'result' }>;
    expect(r).toMatchObject({ isError: true, apiStatus: 429, text: 'Rate limit reached' });
  });
  it('ignores garbage, unknown types and thinking deltas without throwing', () => {
    for (const l of ['', 'garbage', '{"type":', '[]', '12', 'null', '"x"', '{"type":"brand_new"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}}',
      '{"type":"stream_event"}', '{"type":"assistant","message":null}', '{"type":"result"}x']) {
      expect(parseStreamLine(l), l).toEqual([]);
    }
  });
  it('tolerates a result without text or cost', () => {
    expect(parseStreamLine('{"type":"result","is_error":false}')).toEqual([{ t: 'result', isError: false, text: '', structured: undefined, costUsd: null, apiStatus: null }]);
  });
});

describe('parseStreamLine edge cases', () => {
  it('yields one tool item per tool_use block, in order, skipping StructuredOutput', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Read', input: {} }, { type: 'text', text: 'x' },
      { type: 'tool_use', id: 'b', name: 'StructuredOutput', input: {} }, { type: 'tool_use', id: 'c', name: 'Grep', input: {} }] } });
    expect(parseStreamLine(line).map((i) => (i.t === 'tool' ? i.id : '?'))).toEqual(['a', 'c']);
  });
  it('skips a tool_use block without an id', () => {
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}')).toEqual([]);
  });
  it('gives resetsAt null when missing or not a number', () => {
    expect(parseStreamLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}')).toEqual([{ t: 'rate', status: 'allowed', resetsAt: null, window: null }]);
    expect(parseStreamLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":"soon"}}')).toEqual([{ t: 'rate', status: 'rejected', resetsAt: null, window: null }]);
  });
  it('names the limit\'s window: five_hour is the 5-hour one, any seven_day one (Opus, Sonnet too) the weekly one, else none', () => {
    const win = (type: unknown) => (parseStreamLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: type } }))[0] as { window: unknown }).window;
    expect(win('five_hour')).toBe('five-hour');
    expect(win('seven_day')).toBe('weekly');
    expect(win('seven_day_opus')).toBe('weekly');
    expect(win('seven_day_sonnet')).toBe('weekly');
    expect(win('overage')).toBeNull();
    expect(win(7)).toBeNull();
    expect(win(undefined)).toBeNull();
  });
});

describe('traceLine', () => {
  it('shows project files project-relative', () => {
    expect(traceLine({ name: 'Read', input: { file_path: '/p/app/src/a.ts' } }, roots)).toBe('Read src/a.ts');
  });
  it('names the thread files, hiding rules', () => {
    expect(traceLine({ name: 'Read', input: { file_path: '/h/c/S/chat.md' } }, roots)).toBe('Read the chat');
    expect(traceLine({ name: 'Read', input: { file_path: '/h/c/S/facts.md' } }, roots)).toBe('Read the session facts');
    expect(traceLine({ name: 'Read', input: { file_path: '/h/c/S/rules.md' } }, roots)).toBeNull();
  });
  it('describes searches', () => {
    expect(traceLine({ name: 'Grep', input: { pattern: 'skew', path: '/h/c/S' } }, roots)).toBe("Searched the chat for 'skew'");
    expect(traceLine({ name: 'Grep', input: { pattern: 'skew', path: '/p/app/src' } }, roots)).toBe("Searched the code for 'skew'");
    expect(traceLine({ name: 'Grep', input: { pattern: 'skew' } }, roots)).toBe("Searched the code for 'skew'");
    expect(traceLine({ name: 'Grep', input: { pattern: 'x'.repeat(80) } }, roots)).toBe(`Searched the code for '${'x'.repeat(60)}'`);
  });
  it('lists globs', () => {
    expect(traceLine({ name: 'Glob', input: { pattern: 'src/**/*.ts' } }, roots)).toBe('Listed src/**/*.ts');
  });
  it('does not leak outside paths through Glob', () => {
    expect(traceLine({ name: 'Glob', input: { pattern: '/etc/**' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: '../../**/*.pem' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: 'src/../../x' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: '*.ts', path: '/etc' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: '/h/c/S/*.md' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: '/p/app/src/**/*.ts' } }, roots)).toBe('Listed src/**/*.ts');
    expect(traceLine({ name: 'Glob', input: { pattern: '*.ts', path: '/p/app/src' } }, roots)).toBe('Listed *.ts');
  });
  it('macOS: paths compare exactly (case and separator matter)', () => {
    expect(traceLine({ name: 'Read', input: { file_path: '/P/APP/src/a.ts' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Read', input: { file_path: '/p/app\\src\\a.ts' } }, roots)).toBeNull();
    expect(within('/p/app', '/p/app/src/a.ts')).toBe('src/a.ts');
  });
  it('a search path written with a trailing separator is the root itself (both platforms)', () => {
    expect(traceLine({ name: 'Grep', input: { pattern: 'skew', path: '/p/app/' } }, roots)).toBe("Searched the code for 'skew'");
    expect(traceLine({ name: 'Grep', input: { pattern: 'skew', path: '/h/c/S/' } }, roots)).toBe("Searched the chat for 'skew'");
    expect(traceLine({ name: 'Glob', input: { pattern: '*.ts', path: '/p/app//' } }, roots)).toBe('Listed *.ts');
  });
  it('a pattern starting at the home folder (~) is a place outside the project: hidden, as /… is', () => {
    for (const pattern of ['~/.ssh/*', '~', '~/**/*.pem']) expect(traceLine({ name: 'Glob', input: { pattern } }, roots), pattern).toBeNull();
    expect(traceLine({ name: 'Glob', input: { pattern: '~\\.ssh\\*' } }, { project: 'C:/p/app', thread: 'C:/h/c/S' }, 'win32')).toBeNull();
  });
  it('never shows paths outside both roots, nor other tools or odd input', () => {
    expect(traceLine({ name: 'Read', input: { file_path: '/etc/hosts' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Read', input: { file_path: '/p/app/../x/y' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Grep', input: { pattern: 'a', path: '/etc' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Bash', input: { command: 'ls' } }, roots)).toBeNull();
    expect(traceLine({ name: 'Read', input: null }, roots)).toBeNull();
    expect(traceLine({ name: 'Glob', input: {} }, roots)).toBeNull();
  });
});

// Windows: the model's tool inputs are absolute with backslashes (as
// observed, below); main's project root is canonical (C:/…), the thread folder native. Either separator, any case; the
// relative part is shown with forward slashes, as on macOS.
describe('traceLine on Windows', () => {
  const ROOT = 'C:\\dev\\spike-ask\\proj [v2] (1)';
  const win = { project: 'C:/dev/spike-ask/proj [v2] (1)', thread: 'C:\\Users\\Me\\.atelier\\companion\\S' };
  const line = (name: string, input: unknown) => traceLine({ name, input }, win, 'win32');

  it("reads real Windows tool inputs", () => {
    expect(line('Read', { file_path: `${ROOT}\\.env` })).toBe('Read .env');
    expect(line('Read', { file_path: `${ROOT}\\src\\auth\\session.ts` })).toBe('Read src/auth/session.ts');
    expect(line('Grep', { pattern: 'zebra', path: ROOT })).toBe("Searched the code for 'zebra'");
    expect(line('Glob', { pattern: '**/*', path: ROOT })).toBe('Listed **/*');
    expect(line('Read', { file_path: `${win.thread}\\chat.md` })).toBe('Read the chat');
  });
  it('either separator, any case, a trailing separator', () => {
    expect(line('Read', { file_path: 'c:/DEV/Spike-Ask/PROJ [v2] (1)/src/a.ts' })).toBe('Read src/a.ts');
    expect(line('Read', { file_path: 'c:\\users\\me\\.ATELIER\\companion\\s\\facts.md' })).toBe('Read the session facts');
    expect(line('Read', { file_path: `${win.thread}\\rules.md` })).toBeNull();
    expect(line('Grep', { pattern: 'skew', path: `${win.thread}\\` })).toBe("Searched the chat for 'skew'");
    expect(line('Grep', { pattern: 'skew', path: `${ROOT}\\src` })).toBe("Searched the code for 'skew'");
    expect(line('Glob', { pattern: `${ROOT}\\src\\**\\*.ts` })).toBe('Listed src/**/*.ts');
    expect(line('Glob', { pattern: 'src\\**\\*.ts' })).toBe('Listed src/**/*.ts');
  });
  it('never shows a path outside both roots', () => {
    for (const file of ['C:\\Windows\\win.ini', 'D:\\dev\\spike-ask\\proj [v2] (1)\\a.ts', `${ROOT}\\..\\x\\y`, `${ROOT}x\\a.ts`, '\\\\server\\share\\a.ts', `${ROOT}`])
      expect(line('Read', { file_path: file }), file).toBeNull();
    expect(line('Grep', { pattern: 'a', path: 'C:\\Windows' })).toBeNull();
    for (const pattern of ['C:\\Windows\\**', '\\Windows\\**', '/Windows/**', 'D:**\\*.pem', '..\\..\\**\\*.pem', 'src\\..\\..\\x', `${win.thread}\\*.md`])
      expect(line('Glob', { pattern }), pattern).toBeNull();
    expect(line('Glob', { pattern: '*.ts', path: 'C:\\Windows' })).toBeNull();
  });
  it('within: the relative part with forward slashes', () => {
    expect(within(win.project, `${ROOT}\\src\\auth\\session.ts`, 'win32')).toBe('src/auth/session.ts');
    expect(within(`${ROOT}\\`, 'c:/dev/spike-ask/proj [v2] (1)/a.ts', 'win32')).toBe('a.ts');
    expect(within(win.project, `${ROOT}\\src\\..\\..\\x`, 'win32')).toBeNull();
  });
  it('within: a name whose lower case is longer (İ → i̇) still gives the right relative part', () => {
    // toLowerCase('İ') is two code units: the relative part comes from whole names, never a character count.
    expect(within('C:\\İ\\proj', 'c:\\i\u0307\\proj\\a.ts', 'win32')).toBe('a.ts');
    expect(within('C:\\İ\\proj', 'C:\\İ\\proj\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(within('C:\\İ\\proj', 'c:\\i\u0307\\proj', 'win32')).toBeNull();
    expect(within('C:\\İ\\proj', 'c:\\i\u0307\\proj2\\a.ts', 'win32')).toBeNull();
    // A doubled separator is one there: never a relative part that starts like an absolute one.
    expect(within(win.project, `${ROOT}\\\\src\\a.ts`, 'win32')).toBe('src/a.ts');
    expect(within(win.project, `${ROOT}\\\\`, 'win32')).toBeNull();
  });
});
