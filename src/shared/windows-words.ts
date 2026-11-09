// The interface's words on Windows: the strings are written for macOS; on Windows the places and
// tools they name become Windows' own. Whole words only, the most specific first. macOS never goes through here.
import { currentPlatform, type Platform } from './platform';

const WORDS: [RegExp, string][] = [
  // Docker: named pipes.
  [/An absolute path to the engine’s Unix socket \(unix:\/\/ contexts only\)\./g, 'The engine’s named pipe (npipe:// contexts too).'],
  [/Use an absolute path, like \/var\/run\/docker\.sock\./g, 'Use a named pipe, like \\\\.\\pipe\\docker_engine.'],
  [/\/var\/run\/docker\.sock/g, '\\\\.\\pipe\\docker_engine'],
  [/^Socket path$/g, 'Named pipe'],
  // Redis: no Unix sockets on Windows.
  [/ or \/tmp\/redis\.sock/g, ''],
  [/ or an absolute socket path/g, ''],
  [/ \(loopback or a Unix socket\)/g, ' (loopback)'],
  [/\bzsh \(your config\)/g, 'PowerShell (your profile)'],
  [/\byour zsh config\b/g, 'your PowerShell profile'],
  [/\bthe Dock icon\b/g, 'the taskbar icon'],
  [/\bDock badge\b/g, 'taskbar badge'],
  [/\bthe Dock\b/g, 'the taskbar'],
  [/\bthe Keychain\b/g, 'Windows credential protection'],
  [/\bKeychain\b/g, 'Windows credential protection'],
  [/\bthe Trash\b/g, 'the Recycle Bin'],
  [/\bTrash\b/g, 'Recycle Bin'],
  [/\bFinder\b/g, 'File Explorer'],
  [/\bthis Mac\b/g, 'this PC'],
  [/\byour Mac\b/g, 'your PC'],
  [/\bthe Mac\b/g, 'the PC'],
  [/\bmacOS Accessibility\b/g, 'Windows animation effects'],
  [/\bmacOS Keychain\b/g, 'Windows credential protection'],
  [/\bmacOS Focus\b/g, 'Do not disturb'],
  [/\bmacOS\b/g, 'Windows']
];

export function windowsWords(s: string): string {
  return WORDS.reduce((out, [re, to]) => out.replace(re, to), s);
}

/** A string of main's own (a dialog, a git message) in the platform's words. */
export function osWords(s: string, platform: Platform = currentPlatform()): string {
  return platform === 'win32' ? windowsWords(s) : s;
}

/** The strings object with every string (and every string a function of it builds) in Windows' words. */
export function localize<T>(value: T): T {
  if (typeof value === 'string') return windowsWords(value) as T;
  if (typeof value === 'function') {
    const fn = value as unknown as (...a: unknown[]) => unknown;
    return ((...a: unknown[]) => localize(fn(...a))) as T;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v)])) as T;
  }
  if (Array.isArray(value)) return value.map(localize) as T;
  return value;
}
