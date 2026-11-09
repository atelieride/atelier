import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { keepExistingOn, runnerSettings } from './settings';

// Automations became opt-in (2026-11-02): off, the runner reads and starts nothing new, as with Pause All.

test('turned off counts as paused; on, Pause All decides', () => {
  expect(runnerSettings({ ...DEFAULT_SETTINGS, automationsEnabled: false, automationsPaused: false }).paused).toBe(true);
  expect(runnerSettings({ ...DEFAULT_SETTINGS, automationsEnabled: true, automationsPaused: false }).paused).toBe(false);
  expect(runnerSettings({ ...DEFAULT_SETTINGS, automationsEnabled: true, automationsPaused: true }).paused).toBe(true);
  expect(runnerSettings({ ...DEFAULT_SETTINGS, automationsEnabled: true, automationsCap: 5, automationsWhenFull: 'queue', automationsKeepAwake: true }))
    .toEqual({ cap: 5, whenFull: 'queue', paused: false, keepAwake: true });
});

test('someone who already had automations keeps them on, once: only when the setting was never saved', () => {
  expect(keepExistingOn(true, 2)).toBe(true);
  expect(keepExistingOn(true, 0)).toBe(false);
  expect(keepExistingOn(false, 2)).toBe(false);
});
