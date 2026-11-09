// settings.* in the demo: applied with the app's own applyPatch and echoed on `on.settings`, as
// main does for every window; live for the visit, never saved.
import type { AtelierApi } from '@shared/api';
import { DEFAULT_SETTINGS, applyPatch, type Settings } from '@shared/settings';
import { DEMO_HOME, claudeAccountsAt } from '../world/accounts';
import { resolved, type DemoContext } from './context';

/**
 * The demo's starting settings: the defaults with dictation on, as the screenshots run (the mic in the session bar);
 * pressing it says dictation runs on the Mac. Services and Automations on (off by default in the app since 2026-11-02),
 * so visitors see them. The world's two Claude accounts, Personal and Work (world/accounts.ts).
 */
export const DEMO_SETTINGS: Settings = { ...DEFAULT_SETTINGS, dictationEnabled: true, showServices: true, automationsEnabled: true, claudeAccounts: claudeAccountsAt(DEMO_HOME) };

export function createSettings(ctx: DemoContext): AtelierApi['settings'] {
  const change = (next: Settings): Settings => {
    ctx.state.settings = next;
    ctx.events.emit('settings', next);
    return next;
  };
  return {
    get: () => resolved(ctx.state.settings),
    set: (patch) => resolved(change(applyPatch(ctx.state.settings, patch))),
    // main asks first; the demo has no dialog to ask with, and nothing is saved anyway.
    reset: () => resolved(change(DEMO_SETTINGS))
  };
}
