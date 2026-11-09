import { expect, test } from 'vitest';
import { canonicalRequest } from './daemon-wire';

// Requests to atelierd carry canonical paths: main's own paths (path.join, dialogs, realpath)
// are native on Windows, the protocol refuses `\`. Converted once, where main talks to atelierd.

test('Windows: every path field of a request becomes canonical', () => {
  expect(canonicalRequest({ t: 'create', projectRoot: 'c:\\dev\\p', cwd: 'C:\\dev\\p\\src', cols: 80, rows: 24, profile: { shell: 'C:\\Windows\\System32\\cmd.exe' } }, 'win32'))
    .toEqual({ t: 'create', projectRoot: 'C:/dev/p', cwd: 'C:/dev/p/src', cols: 80, rows: 24, profile: { shell: 'C:/Windows/System32/cmd.exe' } });
  expect(canonicalRequest({ t: 'attrPrune', root: 'C:\\dev\\p', dirty: ['C:\\dev\\p\\a.ts', 'C:/dev/p/b.ts'], exclude: ['C:\\dev\\p\\sub'], before: 1 }, 'win32'))
    .toEqual({ t: 'attrPrune', root: 'C:/dev/p', dirty: ['C:/dev/p/a.ts', 'C:/dev/p/b.ts'], exclude: ['C:/dev/p/sub'], before: 1 });
  expect(canonicalRequest({ t: 'resume', id: 'x', cols: 80, rows: 24, configDir: 'C:\\Users\\m\\.claude-b', profile: 'atelier' }, 'win32'))
    .toEqual({ t: 'resume', id: 'x', cols: 80, rows: 24, configDir: 'C:/Users/m/.claude-b', profile: 'atelier' });
});

test('POSIX: the same message, untouched', () => {
  const m = { t: 'create', projectRoot: '/p', cwd: '/p', cols: 80, rows: 24 };
  expect(canonicalRequest(m, 'posix')).toBe(m);
});
