import { expect, test } from 'vitest';
import { localize, osWords, windowsWords } from './windows-words';

// The interface's words on Windows ("Finder → File Explorer, Trash → Recycle Bin, Dock → taskbar,
// Keychain → Windows credential protection, this Mac → this PC"); macOS strings unchanged.

test('macOS places and tools named as Windows has them', () => {
  expect(windowsWords('Reveal in Finder')).toBe('Reveal in File Explorer');
  expect(windowsWords('Open in Finder')).toBe('Open in File Explorer');
  expect(windowsWords('The file is in the Trash: this comment is not sent')).toBe('The file is in the Recycle Bin: this comment is not sent');
  expect(windowsWords('moved to the Trash, so you can get it back')).toBe('moved to the Recycle Bin, so you can get it back');
  expect(windowsWords('Badge on the Dock icon')).toBe('Badge on the taskbar icon');
  expect(windowsWords('A banner, the sound and the Dock badge')).toBe('A banner, the sound and the taskbar badge');
  expect(windowsWords('Speech is transcribed on this Mac; audio never leaves it.')).toBe('Speech is transcribed on this PC; audio never leaves it.');
  expect(windowsWords('Keep the Mac awake while a run works')).toBe('Keep the PC awake while a run works');
  expect(windowsWords("The task's text reaches Claude, on your Mac, with your access.")).toBe("The task's text reaches Claude, on your PC, with your access.");
  expect(windowsWords('Passwords stay in the Keychain')).toBe('Passwords stay in Windows credential protection');
  expect(windowsWords('Claude sessions start in Atelier, or in zsh (your config) when chosen here.')).toBe('Claude sessions start in Atelier, or in PowerShell (your profile) when chosen here.');
  expect(windowsWords('Docker Desktop')).toBe('Docker Desktop');
  // Docker: named pipes.
  expect(windowsWords('An absolute path to the engine’s Unix socket (unix:// contexts only).')).toBe('The engine’s named pipe (npipe:// contexts too).');
  expect(windowsWords('/var/run/docker.sock')).toBe('\\\\.\\pipe\\docker_engine');
  expect(windowsWords('Use an absolute path, like /var/run/docker.sock.')).toBe('Use a named pipe, like \\\\.\\pipe\\docker_engine.');
  // Redis: no Unix sockets on Windows.
  expect(windowsWords('redis://127.0.0.1:6390 or /tmp/redis.sock')).toBe('redis://127.0.0.1:6390');
  expect(windowsWords('Use a local URL (127.0.0.1, localhost) or an absolute socket path.')).toBe('Use a local URL (127.0.0.1, localhost).');
  expect(windowsWords('Atelier connects only to Redis on this Mac (loopback or a Unix socket).')).toBe('Atelier connects only to Redis on this PC (loopback).');
  expect(windowsWords('"System" follows macOS Accessibility.')).toBe('"System" follows Windows animation effects.');
  expect(windowsWords('macOS notification settings')).toBe('Windows notification settings');
  expect(windowsWords('Atelier plays it itself: macOS Focus doesn’t mute it')).toBe('Atelier plays it itself: Do not disturb doesn’t mute it');
});

test('main’s own strings (dialogs, git messages) by platform: Windows’ words there, macOS’s untouched', () => {
  expect(osWords('Move “a.txt” to the Trash?', 'win32')).toBe('Move “a.txt” to the Recycle Bin?');
  expect(osWords('Move “a.txt” to the Trash?', 'darwin')).toBe('Move “a.txt” to the Trash?');
});

test('the whole strings object: nested strings and the functions that build them, nothing else touched', () => {
  const t = { a: 'Open in Finder', n: 3, nested: { b: 'Trash' }, f: (x: number) => `${x} in the Trash` } as const;
  const w = localize(t);
  expect(w.a).toBe('Open in File Explorer');
  expect(w.n).toBe(3);
  expect(w.nested.b).toBe('Recycle Bin');
  expect(w.f(2)).toBe('2 in the Recycle Bin');
});
