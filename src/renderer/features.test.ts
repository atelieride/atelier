import { expect, test } from 'vitest';
import { servicesView, shellCommand, shellEnv } from './features';

// Views a platform has (the tmux Services view is hidden on Windows, decided), and Services only
// once turned on in Settings › Appearance (2026-11-02: few people use tmux).

test('the Services (tmux) view: macOS when turned on, never on Windows', () => {
  expect(servicesView(true, 'darwin')).toBe(true);
  expect(servicesView(false, 'darwin')).toBe(false);
  expect(servicesView(true, 'win32')).toBe(false);
});

test('the `atelier` shell command and the zsh environment capture: macOS only (Windows: no symlink, no capture)', () => {
  expect([shellCommand('darwin'), shellEnv('darwin')]).toEqual([true, true]);
  expect([shellCommand('win32'), shellEnv('win32')]).toEqual([false, false]);
});
