import { describe, expect, test } from 'vitest';
import { createReservedWatcher, reservedMessage } from './reserved';

const k = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

function setup(o: { mac?: boolean; chromium?: boolean } = {}) {
  let t = 1000;
  const w = createReservedWatcher({ mac: o.mac ?? true, chromium: o.chromium ?? true, now: () => t });
  return { w, tick: (ms: number) => { t += ms; } };
}

describe('reservedMessage', () => {
  test('names the shortcut when known; full screen only where it frees the keys (Chromium)', () => {
    expect(reservedMessage('⌘T', true)).toBe('Your browser keeps ⌘T. Use the menu, or go full screen (green light).');
    expect(reservedMessage(null, true)).toBe('Your browser keeps that shortcut. Use the menu, or go full screen (green light).');
    expect(reservedMessage('⌘T', false)).toBe('Your browser keeps ⌘T. Use the menu.');
  });
});

describe('createReservedWatcher', () => {
  test('⌘ then the tab hidden within 600 ms: the hint, on return, once', () => {
    const { w, tick } = setup();
    w.keydown(k('Meta', { meta: true }));
    tick(200);
    w.left('hidden');
    expect(w.back()).toBe(reservedMessage(null, true));
    w.keydown(k('Meta', { meta: true }));
    w.left('hidden');
    expect(w.back()).toBeNull();
  });

  test('the letter, when the browser let the page see it, is named', () => {
    const { w } = setup();
    w.keydown(k('Meta', { meta: true }));
    w.keydown(k('t', { meta: true }));
    w.left('hidden');
    expect(w.back()).toMatch(/keeps ⌘T\./);
  });

  test('a blur alone (⌘Tab to another app) says nothing, unless the key is a reserved one', () => {
    const a = setup();
    a.w.keydown(k('Meta', { meta: true }));
    a.w.left('blur');
    expect(a.w.back()).toBeNull();
    const b = setup();
    b.w.keydown(k('N', { meta: true, shift: true }));
    b.w.left('blur');
    expect(b.w.back()).toMatch(/keeps ⌘⇧N\./);
  });

  test('too late, or a key the page received (not reserved), or no modifier: nothing', () => {
    const late = setup();
    late.w.keydown(k('Meta', { meta: true }));
    late.tick(700);
    late.w.left('hidden');
    expect(late.w.back()).toBeNull();
    const seen = setup();
    seen.w.keydown(k('j', { meta: true }));
    seen.w.left('hidden');
    expect(seen.w.back()).toBeNull();
    const plain = setup();
    plain.w.keydown(k('t'));
    plain.w.left('hidden');
    expect(plain.w.back()).toBeNull();
  });

  test('off a Mac: Ctrl, labelled as such', () => {
    const { w } = setup({ mac: false, chromium: false });
    w.keydown(k('Control', { ctrl: true }));
    w.keydown(k('w', { ctrl: true }));
    w.left('hidden');
    expect(w.back()).toBe('Your browser keeps Ctrl+W. Use the menu.');
    const m = setup({ mac: false });
    m.w.keydown(k('Meta', { meta: true }));
    m.w.left('hidden');
    expect(m.w.back()).toBeNull();
  });

  test('⌃Tab switches tabs on a Mac too', () => {
    const { w } = setup();
    w.keydown(k('Tab', { ctrl: true }));
    w.left('hidden');
    expect(w.back()).toMatch(/keeps ⌃Tab\./);
  });
});
