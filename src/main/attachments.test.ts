import { expect, test } from 'vitest';
import { Attachments } from './attachments';

test('the service is detached only when no window watches the terminal anymore', () => {
  const a = new Attachments();
  a.add(1, 't');
  a.add(2, 't');
  expect(a.remove(1, 't')).toBe(false); // window 2 is still watching
  expect(a.watchers('t')).toEqual([2]);
  expect(a.remove(2, 't')).toBe(true);
  expect(a.watchers('t')).toEqual([]);
});
test('closing a window: returns the terminals to detach in the service', () => {
  const a = new Attachments();
  a.add(1, 'x'); a.add(1, 'y'); a.add(2, 'y');
  expect(a.removeWindow(1).sort()).toEqual(['x']);
  expect(a.has(2, 'y')).toBe(true);
});
test('removing what isn\'t there detaches nothing', () => {
  const a = new Attachments();
  expect(a.remove(1, 'z')).toBe(false);
  expect(a.removeWindow(9)).toEqual([]);
});
test('terminal exit: forgotten by all windows', () => {
  const a = new Attachments();
  a.add(1, 't'); a.add(2, 't');
  a.forgetTerminal('t');
  expect(a.watchers('t')).toEqual([]);
});

// Input typed while a window's attach is still on its way (the terminal is on screen, its snapshot not yet): held and
// sent in order once attached, instead of dropped (a lost first keystroke right after opening a terminal).
test('input during a pending attach is held, then handed over in order when the attach completes', () => {
  const a = new Attachments();
  expect(a.hold(1, 't', 'e')).toBe(false);
  a.begin(1, 't');
  expect(a.has(1, 't')).toBe(false);
  expect(a.hold(1, 't', 'e')).toBe(true);
  expect(a.hold(1, 't', 'cho hi\r')).toBe(true);
  // Another window's pending attach is its own.
  expect(a.hold(2, 't', 'x')).toBe(false);
  expect(a.complete(1, 't')).toEqual(['e', 'cho hi\r']);
  expect(a.has(1, 't')).toBe(true);
  expect(a.hold(1, 't', 'later')).toBe(false);
});

test('a failed attach or a closed window drops what was held; the hold is bounded', () => {
  const a = new Attachments();
  a.begin(1, 't');
  a.hold(1, 't', 'x');
  a.abort(1, 't');
  expect(a.hold(1, 't', 'y')).toBe(false);
  expect(a.complete(1, 't')).toBeNull();
  a.begin(2, 'u');
  a.hold(2, 'u', 'z');
  a.removeWindow(2);
  expect(a.hold(2, 'u', 'z')).toBe(false);
  a.begin(3, 'v');
  expect(a.hold(3, 'v', 'a'.repeat(256 * 1024))).toBe(true);
  // Past 256 KB nothing is kept (a paste into a terminal that never attaches must not grow without bound).
  expect(a.hold(3, 'v', 'b')).toBe(false);
  expect(a.complete(3, 'v')).toEqual([]);
});

test('past the bound nothing of that input goes through: all or nothing, never the tail of a paste', () => {
  const a = new Attachments();
  a.begin(1, 'p');
  expect(a.hold(1, 'p', 'x'.repeat(100))).toBe(true);
  // A 512 KB paste piece overflows: what was held goes too, and every later piece is refused.
  expect(a.hold(1, 'p', 'y'.repeat(512 * 1024))).toBe(false);
  expect(a.hold(1, 'p', 'tail\r')).toBe(false);
  expect(a.complete(1, 'p')).toEqual([]);
});

test('two attaches of one terminal from one window (a remount) share what is held until the last one ends', () => {
  const a = new Attachments();
  a.begin(1, 'r');
  a.hold(1, 'r', 'a');
  a.begin(1, 'r');
  a.hold(1, 'r', 'b');
  a.abort(1, 'r');
  expect(a.hold(1, 'r', 'c')).toBe(true);
  expect(a.complete(1, 'r')).toEqual(['a', 'b', 'c']);
});

test('an attach that completes for a window already gone (closed mid-attach) does not make it a watcher', () => {
  const a = new Attachments();
  a.begin(5, 'w');
  a.removeWindow(5);
  expect(a.complete(5, 'w')).toBeNull();
  expect(a.watchers('w')).toEqual([]);
});
test('pane sizes: only one that never reached atelierd is kept, taken once; forgotten with the window or the terminal', () => {
  const a = new Attachments();
  a.sized(1, 't', 100, 30, false);
  expect(a.takeUndelivered(1, 't')).toBeNull(); // not attached: nothing to send it to later
  a.begin(1, 't');
  a.sized(1, 't', 120, 36, false);
  a.complete(1, 't');
  expect(a.takeUndelivered(1, 't')).toEqual({ cols: 120, rows: 36 });
  expect(a.takeUndelivered(1, 't')).toBeNull();
  a.sized(1, 't', 90, 20, false);
  a.sized(1, 't', 91, 21, true); // a later size that did reach it: nothing left to send
  expect(a.takeUndelivered(1, 't')).toBeNull();
  a.sized(1, 't', 80, 24, false);
  a.remove(1, 't'); // a reconnection removes, then attaches again: the size must stay
  a.begin(1, 't'); a.complete(1, 't');
  expect(a.takeUndelivered(1, 't')).toEqual({ cols: 80, rows: 24 });
  a.add(1, 'u'); a.sized(1, 'u', 90, 20, false);
  a.add(2, 't'); a.sized(2, 't', 80, 24, false);
  a.forgetTerminal('t');
  expect(a.takeUndelivered(2, 't')).toBeNull();
  a.removeWindow(1);
  expect(a.takeUndelivered(1, 'u')).toBeNull();
});

// A window leaving a terminal while another window's attach is on its way is not
// "the last": detaching atelierd's single listener then would leave the newcomer with a snapshot and no output.
test('remove and removeWindow: never the last while another window is attaching the terminal', () => {
  const a = new Attachments();
  a.add(1, 't');
  a.begin(2, 't');
  expect(a.remove(1, 't')).toBe(false);
  a.add(1, 't');
  expect(a.removeWindow(1)).toEqual([]);
  expect(a.complete(2, 't')).toEqual([]);
  expect(a.remove(2, 't')).toBe(true);
});
