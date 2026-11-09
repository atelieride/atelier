import { describe, expect, test } from 'vitest';
import { projectRead } from './run';

// What an answer read (its header's "read N files"), from the runner's Read tool events: pure, so it runs on every
// machine (run.test.ts starts a #! fake and is POSIX-only). Each case names its path style.

describe('what an answer read (projectRead)', () => {
  test('macOS: project files project-relative; the thread\'s own files and outside paths never', () => {
    const roots = { thread: ['/h/c/S'], project: ['/p/app', '/private/p/app'] };
    expect(projectRead('/private/p/app/src/a.ts', roots, 'posix')).toBe('src/a.ts');
    expect(projectRead('/h/c/S/chat.md', roots, 'posix')).toBeNull();
    expect(projectRead('/etc/hosts', roots, 'posix')).toBeNull();
  });
  test('Windows: the native paths the model writes, any case, read against canonical or native roots', () => {
    const roots = { thread: ['C:\\Users\\Me\\.atelier\\companion\\S'], project: ['C:/dev/spike-ask/proj [v2] (1)'] };
    expect(projectRead('C:\\dev\\spike-ask\\proj [v2] (1)\\src\\auth\\session.ts', roots, 'win32')).toBe('src/auth/session.ts');
    expect(projectRead('c:\\DEV\\spike-ask\\proj [v2] (1)\\README.md', roots, 'win32')).toBe('README.md');
    expect(projectRead('C:\\Users\\Me\\.atelier\\companion\\S\\chat.md', roots, 'win32')).toBeNull();
    expect(projectRead('C:\\Windows\\win.ini', roots, 'win32')).toBeNull();
  });
});
