/**
 * A background shell's output file as lines: UTF-8 decoded across chunks, ANSI
 * stripped, `\r` rewrites keep their last segment, lines clipped, a bounded buffer, and Claude Code's
 * `[exited with code N]` trailer read as the exit code. Pure.
 */
export const LINE_MAX = 2000;
export const BUFFER_LINES = 5000;
/** Raw size an unfinished line may reach before only its visible tail is kept (a memory bound). */
const RAW_MAX = 4 * LINE_MAX;

const EXIT = /^\[exited with code (\d+)\]$/;
// CSI, OSC (BEL or ST terminated) and two-character escapes. `]` is not a two-character escape: an OSC cut short by
// a chunk boundary stays whole in the carried partial, hidden from `live` until it completes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\^_]/g;
// What a line ended before finishing leaves behind: an ESC, an ESC [ with its params, or an ESC ] up to the end.
const UNFINISHED = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?/g;

const clip = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX)}…` : s);
/** What a terminal shows of a line rewritten with `\r`: its last non-empty segment. */
const visible = (s: string) => s.split('\r').filter(Boolean).at(-1) ?? '';
/** A completed line as shown: unfinished escapes gone, rewrites applied, clipped. */
const finish = (raw: string) => clip(visible(raw.replace(UNFINISHED, '')));
/** The raw unfinished line carried to the next chunk. Past the bound only its visible tail is kept, a trailing CR too. */
const bound = (raw: string) => {
  if (raw.length <= RAW_MAX) return raw;
  const cr = raw.endsWith('\r');
  return clip(visible(cr ? raw.slice(0, -1) : raw)) + (cr ? '\r' : '');
};

export class OutputTail {
  lines: string[] = [];
  live = '';
  exit: number | null = null;
  dropped = 0;
  seq = 0;
  private decoder = new TextDecoder('utf-8');
  /** The unfinished line, raw: a CR or an escape split across chunks must still join up with the next chunk. */
  private partial = '';
  /** A blank line ending the last chunk, held back: it may be the one Claude Code writes before the trailer. */
  private pendingBlank = false;

  push(bytes: Uint8Array): string[] {
    const text = (this.partial + this.decoder.decode(bytes, { stream: true })).replace(ANSI, '').replace(/\r\n/g, '\n');
    const parts = text.split('\n');
    this.partial = bound(parts.pop() ?? '');
    this.live = clip(visible(this.partial.replace(UNFINISHED, '')));
    const added: string[] = [];
    for (const raw of parts) {
      const line = finish(raw);
      const m = EXIT.exec(line);
      if (m) {
        this.exit = Number(m[1]);
        // Claude Code writes a blank line before the trailer: it is dropped, held back or not.
        this.pendingBlank = false;
        if (added.at(-1) === '') added.pop();
        continue;
      }
      if (this.pendingBlank) {
        added.push('');
        this.pendingBlank = false;
      }
      added.push(line);
    }
    // A blank line that ends this chunk is held until the next completed line shows whether it is the trailer's.
    if (added.at(-1) === '') {
      added.pop();
      this.pendingBlank = true;
    }
    for (const line of added) this.lines.push(line);
    this.seq += added.length;
    if (this.lines.length > BUFFER_LINES) {
      const over = this.lines.length - BUFFER_LINES;
      this.lines.splice(0, over);
      this.dropped += over;
    }
    return added;
  }

  reset(): void {
    this.lines = []; this.live = ''; this.exit = null; this.dropped = 0; this.seq = 0;
    this.decoder = new TextDecoder('utf-8'); this.partial = ''; this.pendingBlank = false;
  }
}
