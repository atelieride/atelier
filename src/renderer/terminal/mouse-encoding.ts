const TRACKING = /\x1b\[\?(?:9|1000|1002|1003)h/;
const ENCODING = /\x1b\[\?(?:1006|1016)[hl]/;

/**
 * Claude's screen from an atelierd started before snapshot-modes.ts turns the mouse tracking on without naming its
 * encoding (the serialize addon leaves it out): taken as SGR, what Claude asks for. Left in X10, xterm reports the wheel
 * as bytes (onBinary) Atelier never sends: after a restart Claude couldn't be scrolled until it set its modes again.
 * Only Claude's: vim takes SGR from xterm version 277 and xterm.js reports 276, so vim asks for X10 and SGR reports
 * would reach it as keystrokes. A newer atelierd names the encoding either way, so nothing is guessed.
 */
export function withMouseEncoding(snapshot: string, claude: boolean): string {
  return claude && TRACKING.test(snapshot) && !ENCODING.test(snapshot) ? `${snapshot}\x1b[?1006h` : snapshot;
}
