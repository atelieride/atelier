import { expect, test } from 'vitest';
import { matchesShortcut, onKey } from './keys';

test('hold: starts, on release (after 300 ms) stops and transcribes', () => {
  let r = onKey('idle', { type: 'down', at: 1000 });
  expect(r).toEqual({ state: 'holding', action: 'start' });
  r = onKey('holding', { type: 'up', at: 2500, downAt: 1000 });
  expect(r).toEqual({ state: 'busy', action: 'stop' });
});

test('short tap: hands-free; another tap stops', () => {
  expect(onKey('holding', { type: 'up', at: 1200, downAt: 1000 })).toEqual({ state: 'handsfree', action: null });
  expect(onKey('handsfree', { type: 'down', at: 5000 })).toEqual({ state: 'busy', action: 'stop' });
});

test('Esc cancels; the window losing focus while holding = stop; clicking the microphone', () => {
  expect(onKey('holding', { type: 'escape', at: 1 })).toEqual({ state: 'idle', action: 'cancel' });
  expect(onKey('handsfree', { type: 'escape', at: 1 })).toEqual({ state: 'idle', action: 'cancel' });
  expect(onKey('holding', { type: 'blur', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
  expect(onKey('handsfree', { type: 'blur', at: 1 })).toEqual({ state: 'handsfree', action: null });
  expect(onKey('idle', { type: 'click', at: 1 })).toEqual({ state: 'handsfree', action: 'start' });
  expect(onKey('handsfree', { type: 'click', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
});

test('while transcribing (busy) and when idle the keys do nothing', () => {
  expect(onKey('busy', { type: 'down', at: 1 })).toEqual({ state: 'busy', action: null });
  expect(onKey('idle', { type: 'up', at: 1, downAt: 0 })).toEqual({ state: 'idle', action: null });
  expect(onKey('idle', { type: 'escape', at: 1 })).toEqual({ state: 'idle', action: null });
});

const k = (o: Partial<KeyboardEvent>) => ({ code: 'Space', key: ' ', altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...o }) as KeyboardEvent;

test('shortcuts: ⌥Space (also with ⇧ for raw), ⌃⌥Space, F5; no false positives', () => {
  expect(matchesShortcut(k({ altKey: true }), 'alt-space')).toBe(true);
  expect(matchesShortcut(k({ altKey: true, shiftKey: true }), 'alt-space')).toBe(true);
  expect(matchesShortcut(k({ altKey: true, metaKey: true }), 'alt-space')).toBe(false);
  expect(matchesShortcut(k({}), 'alt-space')).toBe(false);
  expect(matchesShortcut(k({ altKey: true, ctrlKey: true }), 'ctrl-alt-space')).toBe(true);
  expect(matchesShortcut(k({ altKey: true }), 'ctrl-alt-space')).toBe(false);
  expect(matchesShortcut(k({ code: 'F5', key: 'F5' }), 'f5')).toBe(true);
  expect(matchesShortcut(k({ code: 'F5', key: 'F5', metaKey: true }), 'f5')).toBe(false);
});

test('5-minute limit: stops and transcribes both when holding and hands-free', () => {
  expect(onKey('holding', { type: 'limit', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
  expect(onKey('handsfree', { type: 'limit', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
  expect(onKey('idle', { type: 'limit', at: 1 })).toEqual({ state: 'idle', action: null });
});

test('Enter while listening: stops and transcribes (does not send the message); when idle does nothing', () => {
  expect(onKey('handsfree', { type: 'enter', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
  expect(onKey('holding', { type: 'enter', at: 1 })).toEqual({ state: 'busy', action: 'stop' });
  expect(onKey('idle', { type: 'enter', at: 1 })).toEqual({ state: 'idle', action: null });
});
