// Settings › Automations as the runner reads them, and the one-time switch of 2026-11-02 (automations became opt-in).
import type { AutomationsSettings } from '@shared/automations';
import type { Settings } from '@shared/settings';

/** Turned off counts as Pause All: nothing new is read or started (runs at work finish as they would). */
export function runnerSettings(s: Settings): AutomationsSettings {
  return { cap: s.automationsCap, whenFull: s.automationsWhenFull, paused: s.automationsPaused || !s.automationsEnabled, keepAwake: s.automationsKeepAwake };
}

/**
 * Automations are off until turned on; someone who already has some keeps them working: turned on once, at the first
 * start whose preferences never had the setting (absent), when automations.json holds at least one.
 */
export function keepExistingOn(absent: boolean, count: number): boolean {
  return absent && count > 0;
}
