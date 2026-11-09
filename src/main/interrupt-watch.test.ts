import { expect, test } from 'vitest';
import { INTERRUPT_GRACE_MS, INTERRUPT_KEY_MS, INTERRUPT_QUIET_MS, InterruptWatch } from './interrupt-watch';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';

const T0 = 1_000_000;
const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId: 's1', state: 'running', activity: 'Bash npm test', updatedAt: T0, unread: false, waitingFor: null, ...over }) as SessionInfo;
const term = (s: SessionInfo | null, id = 't1'): TerminalInfo =>
  ({ id, projectRoot: '/p', cwd: '/p', title: id, name: null, color: '#B794F6', foreground: 'claude', createdAt: 0, session: s });
// What Claude Code draws after an interruption, with its colors and a cursor move in the middle.
const DRAWN = '\x1b[2K\x1b[38;5;246m  ⎿  \x1b[39m\x1b[31mInterrupted\x1b[39m\x1b[1C· What should Claude do instead?\r\n';

test('Ctrl+C or Esc, then Claude draws "Interrupted": the running session reads as ready until its next event', () => {
  for (const key of ['\x03', '\x1b']) {
    const w = new InterruptWatch();
    w.input('t1', key, T0 + 500);
    expect(w.output('t1', DRAWN, T0 + 600)).toBe(true);
    const [out] = w.apply([term(session())]);
    expect(out!.session).toMatchObject({ state: 'idle', activity: null, waitingFor: 'input' });
  }
});

test('ConPTY (Windows) draws every space as a cursor move: still read as the interruption', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  const conpty = '\x1b[2K\x1b[38;5;246m\x1b[2C⎿\x1b[2C\x1b[39m\x1b[31mInterrupted\x1b[39m\x1b[1C·\x1b[1CWhat\x1b[1Cshould\x1b[1CClaude\x1b[1Cdo\x1b[1Cinstead?\x1b[5;1H';
  expect(w.output('t1', conpty, T0 + 600)).toBe(true);
});

test('waiting on a permission and dismissed with Esc: ready too', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x1b', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  expect(w.apply([term(session({ state: 'waiting', waitingFor: 'permission' }))])[0]!.session!.state).toBe('idle');
});

test('the drawn text split across chunks still counts', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  expect(w.output('t1', DRAWN.slice(0, 40), T0 + 550)).toBe(false);
  expect(w.output('t1', DRAWN.slice(40), T0 + 560)).toBe(true);
});

test('the text alone (Claude printing a file that contains it) or long after the key changes nothing', () => {
  const w = new InterruptWatch();
  expect(w.output('t1', DRAWN, T0 + 600)).toBe(false);
  w.input('t1', '\x03', T0 + 600);
  expect(w.output('t1', DRAWN, T0 + 600 + 10_000)).toBe(false);
  expect(w.apply([term(session())])[0]!.session!.state).toBe('running');
  // Other keys arm nothing (an arrow key starts with ESC, it is no Esc).
  w.input('t1', '\x1b[A', T0 + 30_000);
  expect(w.output('t1', DRAWN, T0 + 30_100)).toBe(false);
});

/** Interrupted at T0 + 600 while running `Bash npm test`; the list as main sent it right then. */
function interrupted() {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  w.apply([term(session())]);
  return w;
}
const stateAfter = (w: InterruptWatch, over: Partial<SessionInfo>) => w.apply([term(session(over))])[0]!.session!.state;
const AFTER = T0 + 600 + INTERRUPT_GRACE_MS + 1;

test('events of the interrupted turn keep it ready, however late: the tool\'s failure, the dialog\'s notice', () => {
  const w = interrupted();
  // The interrupted tool's PostToolUseFailure, within the grace or slow to die after it (same tool, still "running").
  expect(stateAfter(w, { updatedAt: T0 + 600 + INTERRUPT_GRACE_MS })).toBe('idle');
  expect(stateAfter(w, { updatedAt: AFTER + 5000 })).toBe('idle');
  // A dialog dismissed with Esc: its notice comes ~6 s later, the session still "waiting" on the same dialog.
  const d = new InterruptWatch();
  d.input('t1', '\x1b', T0 + 500);
  d.output('t1', DRAWN, T0 + 600);
  const dialog = { state: 'waiting' as const, activity: 'waiting: Bash npm test', waitingFor: 'permission' as const };
  d.apply([term(session(dialog))]);
  expect(stateAfter(d, { ...dialog, updatedAt: AFTER + 3000 })).toBe('idle');
});

test('the prompt sent with Enter after the interruption, or a tool of a new turn, is Claude Code\'s own state again', () => {
  // A typed prompt: its UserPromptSubmit (any event after the Enter) wins at once, even within the grace.
  const w = interrupted();
  w.input('t1', 'fix the test\r', T0 + 1500);
  expect(stateAfter(w, { activity: null, updatedAt: T0 + 1600 })).toBe('running');
  expect(stateAfter(w, { updatedAt: T0 + 400 })).toBe('running');
  // A new turn without a typed prompt (a background task woke Claude): its first tool differs from the interrupted one.
  const v = interrupted();
  expect(stateAfter(v, { activity: 'Read a.ts', updatedAt: AFTER })).toBe('running');
  // The turn ended or Claude Code's idle notice came: nothing to override any more.
  const x = interrupted();
  expect(stateAfter(x, { state: 'idle', activity: null, updatedAt: AFTER })).toBe('idle');
  expect(stateAfter(x, { updatedAt: AFTER + 10 })).toBe('running');
});

test('Shift+Enter, a pasted newline or an Enter with no event after it: still ready', () => {
  const w = interrupted();
  w.input('t1', '\x1b\r', T0 + 1000);
  w.input('t1', 'line one\rline two', T0 + 1100);
  expect(stateAfter(w, { updatedAt: T0 + 1200 })).toBe('idle');
  w.input('t1', '\r', T0 + 1300);
  expect(stateAfter(w, { updatedAt: T0 + 1200 })).toBe('idle');
});

test('the prompt sent right after the key, before the drawing (its hook late): still interrupted', () => {
  // Typed and interrupted at once: UserPromptSubmit lands after the drawing, within the grace.
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  expect(w.apply([term(session({ state: 'done', activity: null }))])[0]!.session!.state).toBe('done');
  expect(stateAfter(w, { activity: null, updatedAt: T0 + 900 })).toBe('idle');
  expect(stateAfter(w, { activity: null, updatedAt: AFTER + 20_000 })).toBe('idle');
});

test('idle, done or no session: untouched; other terminals untouched', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  const done = session({ state: 'done' });
  const list = [term(done), term(session(), 't2'), term(null, 't3')];
  const out = w.apply(list);
  expect(out[0]!.session).toBe(done);
  expect(out[1]).toBe(list[1]);
  expect(out[2]).toBe(list[2]);
});

test('a terminal that exits is forgotten', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  w.forget('t1');
  expect(w.apply([term(session())])[0]!.session!.state).toBe('running');
});

// An interruption before Claude wrote anything: Claude Code takes the prompt back,
// draws no "Interrupted" line and sends no hook. Its spinner redraws all through a turn, so a key followed by quiet is it.
const thinking = () => session({ activity: null });
/** A window shows the terminal (its output reaches main) and Claude Code's motion is normal. */
const SEEN = { watched: true, reduced: false };

test('Esc or Ctrl+C on a running session, then quiet (Claude took the prompt back, no line drawn): ready until it moves on', () => {
  for (const key of ['\x1b', '\x03']) {
    const w = new InterruptWatch();
    expect(w.input('t1', key, T0 + 500)).toBe(true);
    expect(w.quietDue('t1')).toBe(T0 + 500 + INTERRUPT_QUIET_MS);
    // Claude redraws its prompt with the text given back: the quiet counts from there.
    expect(w.output('t1', '\x1b[2K> fix the test', T0 + 600)).toBe(false);
    expect(w.quietDue('t1')).toBe(T0 + 600 + INTERRUPT_QUIET_MS);
    expect(w.quiet('t1', T0 + 600 + INTERRUPT_QUIET_MS - 1, thinking(), SEEN)).toBe('wait');
    expect(w.quiet('t1', T0 + 600 + INTERRUPT_QUIET_MS, thinking(), SEEN)).toBe('settled');
    expect(w.quietDue('t1')).toBeNull();
    expect(w.apply([term(thinking())])[0]!.session).toMatchObject({ state: 'idle', activity: null, waitingFor: 'input' });
    // The prompt sent again: Claude Code's own state at its first event.
    w.input('t1', '\r', T0 + 4000);
    expect(w.apply([term(session({ activity: null, updatedAt: T0 + 4100 }))])[0]!.session!.state).toBe('running');
  }
});

test('output that keeps coming (the spinner: the key closed a menu, Claude still works) settles nothing', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x1b', T0);
  let now = T0;
  for (; now <= T0 + INTERRUPT_KEY_MS; now += 300) {
    w.output('t1', '\x1b[1G✻ Thinking…', now);
    expect(w.quiet('t1', now, thinking(), SEEN)).toBe('wait');
  }
  // Past the key's window the watch ends, whatever comes next.
  expect(w.quiet('t1', now + INTERRUPT_QUIET_MS, thinking(), SEEN)).toBe('drop');
  expect(w.quietDue('t1')).toBeNull();
  expect(w.apply([term(thinking())])[0]!.session!.state).toBe('running');
});

test('quiet makes nothing ready for a dialog, an idle, done or gone session, or with Claude Code\'s reduced motion', () => {
  const at = T0 + 500 + INTERRUPT_QUIET_MS;
  const cases: [SessionInfo | null, { watched: boolean; reduced: boolean }][] = [
    [session({ state: 'waiting', waitingFor: 'permission', activity: 'waiting: Bash npm test' }), SEEN],
    [session({ state: 'running', waitingFor: 'question' }), SEEN],
    [session({ state: 'idle', activity: null }), SEEN],
    [session({ state: 'done', activity: null }), SEEN],
    [null, SEEN],
    // Reduced motion: the spinner stands still while Claude works.
    [thinking(), { watched: true, reduced: true }]
  ];
  for (const [s, o] of cases) {
    const w = new InterruptWatch();
    w.input('t1', '\x1b', T0 + 500);
    expect(w.quiet('t1', at, s, o)).toBe('drop');
    expect(w.apply([term(s)])[0]!.session).toBe(s);
    // The drawn line, if it comes, still counts (a dialog dismissed with Esc).
    expect(w.output('t1', DRAWN, at + 100)).toBe(true);
  }
});

test('no window watching (or main cut off from atelierd): no output can come, so the key is let go at once', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x1b', T0 + 500);
  expect(w.quiet('t1', T0 + 500 + INTERRUPT_QUIET_MS, thinking(), { watched: false, reduced: false })).toBe('drop');
  expect(w.quietDue('t1')).toBeNull();
  expect(w.output('t1', DRAWN, T0 + 2100)).toBe(false);
  expect(w.apply([term(thinking())])[0]!.session!.state).toBe('running');
});

test('an Enter typed after the key: it belonged to the turn before, quiet makes nothing ready', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x1b', T0 + 500);
  // Shift+Enter is no Enter.
  w.input('t1', '\x1b\r', T0 + 600);
  expect(w.quietDue('t1')).toBe(T0 + 500 + INTERRUPT_QUIET_MS);
  w.input('t1', 'next prompt\r', T0 + 700);
  expect(w.quietDue('t1')).toBeNull();
  expect(w.quiet('t1', T0 + 700 + INTERRUPT_QUIET_MS, thinking(), SEEN)).toBe('drop');
  expect(w.apply([term(thinking())])[0]!.session!.state).toBe('running');
});

test('the drawn line first: nothing left for the quiet check; other keys arm nothing; an exit forgets it', () => {
  const w = new InterruptWatch();
  w.input('t1', '\x03', T0 + 500);
  w.output('t1', DRAWN, T0 + 600);
  expect(w.quietDue('t1')).toBeNull();
  expect(w.quiet('t1', T0 + 600 + INTERRUPT_QUIET_MS, thinking(), SEEN)).toBe('drop');
  expect(w.apply([term(thinking())])[0]!.session!.state).toBe('idle');
  const v = new InterruptWatch();
  expect(v.input('t1', '\x1b[A', T0)).toBe(false);
  expect(v.input('t1', 'x', T0)).toBe(false);
  expect(v.quietDue('t1')).toBeNull();
  v.input('t1', '\x1b', T0);
  v.forget('t1');
  expect(v.quietDue('t1')).toBeNull();
  expect(v.quiet('t1', T0 + INTERRUPT_QUIET_MS, thinking(), SEEN)).toBe('drop');
});
