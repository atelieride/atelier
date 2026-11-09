// What xterm must know of a Windows pty (its `windowsPty` option), for the window's terminals and atelierd's headless
// screens alike. Without it xterm reflows the buffer on a resize, which ConPTY doesn't expect (it redraws the screen
// itself): lines came out twice or went missing. Pure: the caller passes the OS version (os.release(), or the
// preload's process.getSystemVersion(): `10.0.26200`).
import type { Platform } from './platform';

export interface WindowsPty { backend: 'conpty' | 'winpty'; buildNumber: number }

/** node-pty's own choice (windowsPtyAgent): ConPTY from build 18309, winpty before or when the build can't be read. */
export function windowsPtyFor(platform: Platform, osVersion: string): WindowsPty | undefined {
  if (platform !== 'win32') return undefined;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(osVersion);
  const buildNumber = m ? parseInt(m[3]!, 10) : 0;
  return { backend: buildNumber >= 18309 ? 'conpty' : 'winpty', buildNumber };
}

/**
 * Whether closing this console waits for every program in it: ClosePseudoConsole did before Windows 11 24H2 (build
 * 26100), on atelierd's own thread, while Claude's SessionEnd hook waits for atelierd (3-4 s on Windows 10, every
 * terminal frozen meanwhile). Then the shell's process tree ends first. winpty and macOS close their own way.
 */
export function closeWaitsForPrograms(pty: WindowsPty | undefined): boolean {
  return pty?.backend === 'conpty' && pty.buildNumber < 26100;
}
