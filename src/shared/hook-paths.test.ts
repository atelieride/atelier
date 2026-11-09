import { expect, test } from 'vitest';
import { canonicalPayload } from './hook-paths';

// Hook and status-line payloads carry Windows paths (`C:\Users\…`): canonical before any reducer reads them.
//POSIX payloads pass through untouched, as the same object.

test('Windows: the path fields Atelier reads become canonical; nothing else changes', () => {
  const p = {
    hook_event_name: 'PostToolUse', session_id: 's', cwd: 'c:\\dev\\proj', transcript_path: 'C:\\Users\\m\\.claude\\projects\\C--dev-proj\\s.jsonl',
    agent_transcript_path: 'C:\\Users\\m\\.claude\\projects\\C--dev-proj\\s\\agent.jsonl',
    tool_name: 'Edit', tool_input: { file_path: 'C:\\dev\\proj\\a.ts', old_string: 'C:\\keep\\me', new_string: 'x' },
    workspace: { current_dir: 'C:\\dev\\proj\\sub', project_dir: 'C:\\dev\\proj' }
  };
  expect(canonicalPayload(p, 'win32')).toEqual({
    ...p, cwd: 'C:/dev/proj', transcript_path: 'C:/Users/m/.claude/projects/C--dev-proj/s.jsonl',
    agent_transcript_path: 'C:/Users/m/.claude/projects/C--dev-proj/s/agent.jsonl',
    tool_input: { file_path: 'C:/dev/proj/a.ts', old_string: 'C:\\keep\\me', new_string: 'x' },
    workspace: { current_dir: 'C:/dev/proj/sub', project_dir: 'C:/dev/proj' }
  });
  expect(canonicalPayload({ tool_input: { notebook_path: 'D:\\n.ipynb', path: 'D:\\src' } }, 'win32'))
    .toEqual({ tool_input: { notebook_path: 'D:/n.ipynb', path: 'D:/src' } });
});

test('Windows: relative, UNC and non-string values are left as they are (the reducers refuse them)', () => {
  const p = { cwd: 'proj', transcript_path: '\\\\server\\share\\s.jsonl', tool_input: { file_path: 42 }, workspace: 'x' };
  expect(canonicalPayload(p, 'win32')).toEqual(p);
  expect(canonicalPayload(null, 'win32')).toBe(null);
  expect(canonicalPayload('text', 'win32')).toBe('text');
});

test('POSIX: the same object, untouched', () => {
  const p = { cwd: '/Users/m/proj', tool_input: { file_path: '/Users/m/proj/a.ts' } };
  expect(canonicalPayload(p, 'posix')).toBe(p);
});
