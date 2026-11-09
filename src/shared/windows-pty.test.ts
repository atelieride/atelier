import { expect, test } from 'vitest';
import { closeWaitsForPrograms, windowsPtyFor } from './windows-pty';

// xterm reflows its buffer on a resize unless told the pty is Windows': ConPTY redraws the screen itself, so lines came
// out twice or went missing after a resize. Both xterms (the window's and atelierd's headless one) get the same answer.

test('Windows: ConPTY with the build number, node-pty’s rule (ConPTY from build 18309)', () => {
  expect(windowsPtyFor('win32', '10.0.26200')).toEqual({ backend: 'conpty', buildNumber: 26200 });
  expect(windowsPtyFor('win32', '10.0.19045')).toEqual({ backend: 'conpty', buildNumber: 19045 });
  expect(windowsPtyFor('win32', '10.0.18309')).toEqual({ backend: 'conpty', buildNumber: 18309 });
});

test('Windows before build 18309: node-pty falls back to winpty, and so does an unreadable version', () => {
  expect(windowsPtyFor('win32', '10.0.17763')).toEqual({ backend: 'winpty', buildNumber: 17763 });
  expect(windowsPtyFor('win32', '')).toEqual({ backend: 'winpty', buildNumber: 0 });
});

test('macOS and Linux: no Windows pty, xterm as before', () => {
  expect(windowsPtyFor('darwin', '25.0.0')).toBeUndefined();
  expect(windowsPtyFor('linux', '6.8.0')).toBeUndefined();
});

// ClosePseudoConsole, before Windows 11 24H2 (build 26100), returns only once every program in the console has exited:
// atelierd's thread waits on Claude, whose SessionEnd hook waits on atelierd (3-4 s on a Windows 10 PC, every terminal
// frozen meanwhile). From 24H2 on it returns at once (measured on 25H2: a Claude session closes in under 0.5 s).
test('the console close waits for its programs on ConPTY before build 26100 only', () => {
  expect(closeWaitsForPrograms(windowsPtyFor('win32', '10.0.19045'))).toBe(true);
  expect(closeWaitsForPrograms(windowsPtyFor('win32', '10.0.22631'))).toBe(true);
  expect(closeWaitsForPrograms(windowsPtyFor('win32', '10.0.26100'))).toBe(false);
  expect(closeWaitsForPrograms(windowsPtyFor('win32', '10.0.26200'))).toBe(false);
  // winpty (and an unreadable version) closes its own way; macOS has no console.
  expect(closeWaitsForPrograms(windowsPtyFor('win32', '10.0.17763'))).toBe(false);
  expect(closeWaitsForPrograms(windowsPtyFor('win32', ''))).toBe(false);
  expect(closeWaitsForPrograms(windowsPtyFor('darwin', '25.0.0'))).toBe(false);
});
