import { afterEach, beforeEach, expect, test } from 'vitest';
import { initPlatform, resetPlatformForTests } from './platform';
import { attributionFromHook, pruneAttributions, type Attribution } from './attribution';
import { configDirOf, reduceHook } from './session';
import { applyToolCallHook } from './tool-calls';

// The session reducers on Windows read canonical paths (`C:/…`, made so by hook-paths.ts in atelierd): the absolute
// checks, normalization and folder math that assumed `/`.

beforeEach(() => { initPlatform('win32'); });
afterEach(() => { resetPlatformForTests(); });

const SID = '0a1b2c3d-1111-2222-3333-444455556666';
const term = { id: 't', color: '#fff', title: 'T' };

test('a session keeps its canonical cwd', () => {
  const s = reduceHook(null, { hook_event_name: 'SessionStart', session_id: SID, cwd: 'C:/dev/proj', source: 'startup' }, 1);
  expect(s?.cwd).toBe('C:/dev/proj');
});

test('the Claude config dir comes from a canonical transcript path', () => {
  expect(configDirOf(`C:/Users/m/.claude/projects/C--dev-proj/${SID}.jsonl`)).toBe('C:/Users/m/.claude');
  expect(configDirOf(`C:/Users/m/.claude/../x/projects/C--dev-proj/${SID}.jsonl`)).toBe(null);
  expect(configDirOf(`C:\\Users\\m\\.claude\\projects\\C--dev-proj\\${SID}.jsonl`)).toBe(null);
});

test('an edit is attributed to its canonical, normalized path', () => {
  const edit = (file_path: string) => attributionFromHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', session_id: SID, tool_input: { file_path } }, term, 5);
  expect(edit('C:/dev/proj/./src/../a.ts')?.path).toBe('C:/dev/proj/a.ts');
  expect(edit('relative.ts')).toBe(null);
  expect(edit('/dev/proj/a.ts')).toBe(null);
});

test('attributions are pruned by folder, any case', () => {
  const a = (path: string): Attribution => ({ path, terminalId: 't', sessionId: SID, color: '#fff', title: 'T', at: 1 });
  const list = [a('C:/dev/proj/a.ts'), a('C:/dev/proj/b.ts'), a('C:/dev/other/c.ts')];
  expect(pruneAttributions(list, 'c:/DEV/proj', new Set(['C:/dev/proj/b.ts'])).map((x) => x.path)).toEqual(['C:/dev/proj/b.ts', 'C:/dev/other/c.ts']);
});

test('a still-dirty file is matched in any case (Claude started from c:\\dev, git reports C:/Dev)', () => {
  const a = (path: string): Attribution => ({ path, terminalId: 't', sessionId: SID, color: '#fff', title: 'T', at: 1 });
  expect(pruneAttributions([a('c:/dev/proj/b.ts')], 'C:/Dev/Proj', new Set(['C:/Dev/Proj/b.ts'])).map((x) => x.path)).toEqual(['c:/dev/proj/b.ts']);
});

test('a tool call keeps its canonical cwd', () => {
  const list = applyToolCallHook([], 't', { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'dir' }, cwd: 'C:/dev/proj' }, 1);
  expect(list[0]?.cwd).toBe('C:/dev/proj');
});
