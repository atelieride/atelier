import { expect, test } from 'vitest';
import { claudeCandidates } from './claude-bin';

// The real `claude` for ✦ commit messages, Ask and dictation's polish (never Atelier's wrapper): macOS as before; on
// Windows the native installer's claude.exe, then PATH (each folder's claude.exe, then the claude.exe an npm
// `claude.cmd` there runs: a .cmd itself can't be run without a shell), then npm, WinGet and Scoop's own folders.

test('macOS: the usual places, then PATH; Atelier\'s own folder never', () => {
  expect(claudeCandidates({ home: '/Users/me', path: '/usr/bin:/Users/me/.atelier/bin', atelierHome: '/Users/me/.atelier', platform: 'darwin' })).toEqual([
    '/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'
  ]);
});

const NPM_EXE = 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

test('Windows: claude.exe in .local\\bin, then in PATH; never Atelier\'s folder, never a relative entry', () => {
  expect(claudeCandidates({ home: 'C:\\Users\\me', path: 'C:\\Windows;C:\\Users\\me\\.atelier\\bin;bin;C:\\tools\\', atelierHome: 'C:\\Users\\me\\.atelier', platform: 'win32' })).toEqual([
    'C:\\Users\\me\\.local\\bin\\claude.exe',
    'C:\\Windows\\claude.exe', `C:\\Windows\\${NPM_EXE}`,
    'C:\\tools\\claude.exe', `C:\\tools\\${NPM_EXE}`,
    'C:\\Users\\me\\scoop\\shims\\claude.exe'
  ]);
});

test('Windows: an npm install (the exe its claude.cmd runs), WinGet\'s and Scoop\'s links, also when PATH misses them; each once', () => {
  const env = { home: 'C:\\Users\\me', atelierHome: 'C:\\Users\\me\\.atelier', platform: 'win32' as const, appData: 'C:\\Users\\me\\AppData\\Roaming', localAppData: 'C:\\Users\\me\\AppData\\Local' };
  // npm's folder on PATH (as the Node installer sets it): its claude.cmd's exe in PATH order, not again at the end.
  expect(claudeCandidates({ ...env, path: 'C:\\Windows;c:\\users\\me\\appdata\\roaming\\npm' })).toEqual([
    'C:\\Users\\me\\.local\\bin\\claude.exe',
    'C:\\Windows\\claude.exe', `C:\\Windows\\${NPM_EXE}`,
    'c:\\users\\me\\appdata\\roaming\\npm\\claude.exe', `c:\\users\\me\\appdata\\roaming\\npm\\${NPM_EXE}`,
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe',
    'C:\\Users\\me\\scoop\\shims\\claude.exe'
  ]);
  // An app started before the install (its PATH older than the user's): the usual folders all the same.
  expect(claudeCandidates({ ...env, path: '' })).toEqual([
    'C:\\Users\\me\\.local\\bin\\claude.exe',
    `C:\\Users\\me\\AppData\\Roaming\\npm\\${NPM_EXE}`,
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe',
    'C:\\Users\\me\\scoop\\shims\\claude.exe'
  ]);
});
