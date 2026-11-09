import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { isWaiting } from '@shared/session-view';

// Claude Code sends no hook when a turn is interrupted (Ctrl+C or Esc): no Stop, and the idle notice that brings the
// session back to ready only comes a minute later, if at all. So the session stayed "working". What it does do is draw
// "⎿ Interrupted · What should Claude do instead?" right after the key: the key the user sent (main forwards every
// keystroke) plus that drawing in the next few seconds is the interruption. The text alone never is (Claude printing a
// file that contains it). Main overrides the state of the list it sends until the session moves on (see apply).
//
// Interrupted before it wrote anything, Claude Code draws no line: it puts the prompt back in the input box and never
// sends another hook. Its spinner redraws the screen all through a turn (gaps under
// 0.5 s, thinking and tools included), so the key followed by quiet output on a running session is that interruption.

/** The drawing, or the quiet, must follow the key within this long. */
export const INTERRUPT_KEY_MS = 5_000;
/** A hook event this close after the drawing still belongs to the interruption (the interrupted tool's failure). */
export const INTERRUPT_GRACE_MS = 3_000;
/** No output this long after the key (and after the redraw it causes): the turn is over. */
export const INTERRUPT_QUIET_MS = 1_500;
const TAIL = 400;
const DRAWN = /Interrupted\W{0,8}(?:What should Claude do instead|by user)/;
// CSI and OSC sequences become a space (a cursor move can stand for one), other escapes go.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const isInterruptKey = (data: string) => data.includes('\x03') || data === '\x1b';

/** A submitted line: an Enter typed alone or ending a line Atelier types; never Shift+Enter (ESC CR) or a pasted newline. */
const isSubmit = (data: string) => data.endsWith('\r') && !data.startsWith('\x1b');
const ended = (state: string) => state === 'idle' || state === 'done' || state === 'error';

/**
 * One interruption: when it was drawn, the interrupted turn as the session's events left it within the grace, and the
 * last Enter typed since.
 */
interface Mark { at: number; turn: { state: string; activity: string | null } | null; enterAt: number | null }

/** An interrupt key waiting for its drawing or its quiet: when it was typed, the last output since, an Enter since. */
interface Key { at: number; lastOut: number; submitted: boolean }

export class InterruptWatch {
  private keys = new Map<string, Key>();
  private tails = new Map<string, string>();
  private marks = new Map<string, Mark>();

  /** A keystroke sent to a terminal; true when it is an interrupt key (the hub then checks for quiet, see quiet). */
  input(id: string, data: string, now: number): boolean {
    const mark = this.marks.get(id);
    if (mark && isSubmit(data)) mark.enterAt = now;
    if (!isInterruptKey(data)) {
      const key = this.keys.get(id);
      if (key && isSubmit(data)) key.submitted = true;
      return false;
    }
    this.keys.set(id, { at: now, lastOut: now, submitted: false });
    this.tails.set(id, '');
    return true;
  }

  /** Output of a terminal; true when it just showed an interruption (the list must be sent again). */
  output(id: string, data: string, now: number): boolean {
    const key = this.keys.get(id);
    if (key === undefined) return false;
    if (now - key.at > INTERRUPT_KEY_MS) { this.drop(id); return false; }
    key.lastOut = now;
    const text = ((this.tails.get(id) ?? '') + data.replace(ESCAPES, ' ')).replace(/\s+/g, ' ').slice(-TAIL);
    if (!DRAWN.test(text)) { this.tails.set(id, text); return false; }
    this.mark(id, now);
    return true;
  }

  /** When the quiet check is due for this terminal; null when there is none to make. */
  quietDue(id: string): number | null {
    const key = this.keys.get(id);
    return key && !key.submitted ? key.lastOut + INTERRUPT_QUIET_MS : null;
  }

  /**
   * The quiet check: 'settled' marks the interruption (the list must be sent again), 'wait' asks again at quietDue,
   * 'drop' ends the check (the drawing may still come). From the hub: `watched`, its output reaches main (a window
   * shows the terminal, atelierd connected); `reduced`, Claude Code's reduced motion (its spinner stands still).
   */
  quiet(id: string, now: number, session: SessionInfo | null, o: { watched: boolean; reduced: boolean }): 'settled' | 'wait' | 'drop' {
    const key = this.keys.get(id);
    if (!key || key.submitted) return 'drop';
    // Past the window, or no output can reach main: no drawing will come either.
    if (now - key.at > INTERRUPT_KEY_MS || !o.watched) { this.drop(id); return 'drop'; }
    if (now < key.lastOut + INTERRUPT_QUIET_MS) return 'wait';
    // A dialog dismissed with Esc is the drawing's case; an idle or done session has nothing to bring back.
    if (o.reduced || session?.state !== 'running' || isWaiting(session)) return 'drop';
    this.mark(id, now);
    return 'settled';
  }

  forget(id: string): void {
    this.drop(id);
    this.marks.delete(id);
  }

  private mark(id: string, now: number): void {
    this.drop(id);
    this.marks.set(id, { at: now, turn: null, enterAt: null });
  }

  private drop(id: string): void {
    this.keys.delete(id);
    this.tails.delete(id);
  }

  /**
   * The list with interrupted sessions back to ready. Late events of the interrupted turn (the tool's failure, the
   * dismissed dialog's notice) keep it ready; Claude Code's own state comes back with an event after a typed Enter (the
   * new prompt), a turn that ended (Stop, the idle notice) or a different activity (a new turn's tool).
   */
  apply(list: TerminalInfo[]): TerminalInfo[] {
    if (this.marks.size === 0) return list;
    return list.map((t) => {
      const mark = this.marks.get(t.id);
      const s = t.session;
      if (mark === undefined || !s) return t;
      const drop = () => { this.marks.delete(t.id); return t; };
      if (mark.enterAt !== null && s.updatedAt > mark.enterAt) return drop();
      // Within the grace every event belongs to the interrupted turn (even its own UserPromptSubmit, landing late).
      if (s.updatedAt <= mark.at + INTERRUPT_GRACE_MS) mark.turn = { state: s.state, activity: s.activity };
      else if (ended(s.state) || (s.state === 'running' && s.activity !== mark.turn?.activity)) return drop();
      if (ended(s.state)) return t;
      return { ...t, session: { ...s, state: 'idle', activity: null, waitingFor: 'input' } };
    });
  }
}
