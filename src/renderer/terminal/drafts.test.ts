import { afterEach, expect, test, vi } from 'vitest';
import { adoptTerminals, forgetDraft, hasDraft, holdInput, noteInput, pruneDrafts, releaseInput, sendInput, setDialogProbe } from './drafts';

const ESC = String.fromCharCode(27);
// Every terminal gone: nothing followed, seen or held is left for the next test.
afterEach(() => { forgetDraft('a'); forgetDraft('b'); pruneDrafts(new Set()); });

test('typed text leaves a draft; the Enter that sends it, or Ctrl+C, clears it', () => {
  expect(hasDraft('a')).toBe(false);
  noteInput('a', 'f');
  expect(hasDraft('a')).toBe(true);
  noteInput('a', 'ix the bug');
  noteInput('a', '\r');
  expect(hasDraft('a')).toBe(false);
  noteInput('a', 'oops');
  noteInput('a', '\x03');
  expect(hasDraft('a')).toBe(false);
  // Typed and sent in one write (a fast typist, or ⌘Enter's own Enter): sent.
  noteInput('a', 'go\r');
  expect(hasDraft('a')).toBe(false);
  // Per terminal.
  noteInput('b', 'x');
  expect(hasDraft('a')).toBe(false);
  expect(hasDraft('b')).toBe(true);
});

test('Shift+Enter (ESC CR) is a new line in the draft, not a send', () => {
  noteInput('a', 'line one');
  noteInput('a', ESC + '\r');
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\r');
  expect(hasDraft('a')).toBe(false);
  noteInput('a', ESC + '\r');
  expect(hasDraft('a')).toBe(true);
});

test('Up and Down at the prompt recall Claude\'s history into it: a draft (any modifiers, CSI or SS3)', () => {
  for (const seq of [ESC + '[A', ESC + '[B', ESC + 'OA', ESC + 'OB', ESC + '[1;2A', ESC + '[1;5B']) {
    noteInput('a', seq);
    expect(hasDraft('a'), JSON.stringify(seq)).toBe(true);
    noteInput('a', '\r');
    expect(hasDraft('a')).toBe(false);
  }
  // In a dialog they pick an option: no draft.
  noteInput('a', ESC + '[B', true);
  noteInput('a', ESC + 'OA', true);
  expect(hasDraft('a')).toBe(false);
});

test('an Enter that answers a dialog keeps a draft typed ahead; at the prompt it sends it; Ctrl+C clears it either way', () => {
  noteInput('a', 'typed ahead');
  noteInput('a', '\r', true);
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\r', false);
  expect(hasDraft('a')).toBe(false);
  noteInput('a', 'again');
  noteInput('a', '\x03', true);
  expect(hasDraft('a')).toBe(false);
});

test('sendInput asks whether the terminal shows a dialog', () => {
  const input = vi.fn();
  (globalThis as { window?: unknown }).window = { atelier: { terminals: { input } } };
  let dialog = true;
  setDialogProbe(() => dialog);
  try {
    sendInput('a', 'ahead');
    sendInput('a', '\r');
    expect(hasDraft('a')).toBe(true);
    dialog = false;
    sendInput('a', '\r');
    expect(hasDraft('a')).toBe(false);
  } finally { setDialogProbe(() => false); delete (globalThis as { window?: unknown }).window; }
});

test('closed terminals are forgotten', () => {
  noteInput('a', 'x');
  noteInput('b', 'y');
  pruneDrafts(new Set(['b']));
  expect(hasDraft('a')).toBe(false);
  expect(hasDraft('b')).toBe(true);
});

test('keys and terminal reports that type nothing leave no draft', () => {
  for (const seq of [ESC + '[C', ESC + '[D', ESC + 'OC', ESC + '[I', ESC + '[O', ESC + '[<0;10;5M', ESC + '[<64;3;4m', ESC + '[12;40R', ESC + '[Z', ESC + ']11;rgb:0000/0000/0000' + String.fromCharCode(7), ESC, '\x7f', '\t', '\x15']) {
    noteInput('a', seq);
    expect(hasDraft('a'), JSON.stringify(seq)).toBe(false);
  }
});

test('a paste is a draft, its line breaks included, even split across writes', () => {
  noteInput('a', ESC + '[200~first\rsecond');
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\rthird' + ESC + '[201~');
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\r');
  expect(hasDraft('a')).toBe(false);
  // A paste of only a line break is still something in the prompt.
  noteInput('a', ESC + '[200~\r' + ESC + '[201~');
  expect(hasDraft('a')).toBe(true);
  // Unbracketed text with a CR (no bracketed paste): its last CR sent it.
  noteInput('a', 'a\rb\r');
  expect(hasDraft('a')).toBe(false);
});

test('a terminal that was already running when this window started (app restart, reload): a draft may be there unseen, until the user\'s Enter or Ctrl+C', () => {
  const boot = 10_000;
  adoptTerminals([{ id: 'a', createdAt: boot - 5 }, { id: 'b', createdAt: boot + 5 }], boot);
  expect(hasDraft('a')).toBe(true);
  // Started after this window: everything typed into it went through here.
  expect(hasDraft('b')).toBe(false);
  // Keys that type nothing don't end it; the Enter at Claude's prompt does.
  noteInput('a', ESC + '[C');
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\r', true);
  expect(hasDraft('a')).toBe(true);
  noteInput('a', '\r');
  expect(hasDraft('a')).toBe(false);
  // The next lists don't bring it back.
  adoptTerminals([{ id: 'a', createdAt: boot - 5 }, { id: 'b', createdAt: boot + 5 }], boot);
  expect(hasDraft('a')).toBe(false);
  // Ctrl+C ends it too.
  adoptTerminals([{ id: 'c', createdAt: 1 }], boot);
  expect(hasDraft('c')).toBe(true);
  noteInput('c', '\x03');
  expect(hasDraft('c')).toBe(false);
  forgetDraft('c');
});

test('by default "already running" means created before this module loaded (this window\'s start)', () => {
  adoptTerminals([{ id: 'a', createdAt: 0 }, { id: 'b', createdAt: Date.now() + 60_000 }]);
  expect(hasDraft('a')).toBe(true);
  expect(hasDraft('b')).toBe(false);
});

test('held input (a Session panel command waiting for its Enter): kept in order, sent after the Enter', () => {
  const input = vi.fn();
  (globalThis as { window?: unknown }).window = { atelier: { terminals: { input } } };
  try {
    holdInput('a');
    sendInput('a', 'ty');
    sendInput('a', 'ped\r');
    sendInput('b', 'other terminal');
    expect(input.mock.calls).toEqual([['b', 'other terminal']]);
    releaseInput('a', '\r');
    expect(input.mock.calls.slice(1)).toEqual([['a', '\r'], ['a', 'ty'], ['a', 'ped\r']]);
    expect(hasDraft('a')).toBe(false);
    // Released: straight through again.
    sendInput('a', 'x');
    expect(input.mock.calls.at(-1)).toEqual(['a', 'x']);
    expect(hasDraft('a')).toBe(true);
    // A terminal gone while held: what it held goes with it.
    holdInput('a');
    sendInput('a', 'lost with the terminal');
    pruneDrafts(new Set());
    sendInput('a', 'y');
    expect(input.mock.calls.at(-1)).toEqual(['a', 'y']);
  } finally { delete (globalThis as { window?: unknown }).window; }
});

test('sendInput notes and forwards to the terminal', () => {
  const input = vi.fn();
  (globalThis as { window?: unknown }).window = { atelier: { terminals: { input } } };
  try {
    sendInput('a', '@src/x.ts ');
    expect(input).toHaveBeenCalledWith('a', '@src/x.ts ');
    expect(hasDraft('a')).toBe(true);
  } finally { delete (globalThis as { window?: unknown }).window; }
});
