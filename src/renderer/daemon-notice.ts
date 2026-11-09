import type { TerminalInfo } from '@shared/protocol';
import { t } from './i18n/en';

/**
 * Listening ports need terminal pids, which only an atelierd of v2.1 or later sends: with terminals and none carrying
 * one, a restart would bring the chips (unless they are turned off). Without terminals there is nothing to tell.
 */
export function portsNeedRestart(terminals: readonly TerminalInfo[], showPorts: boolean): boolean {
  return showPorts && terminals.length > 0 && terminals.every((x) => x.pid === undefined);
}

/**
 * The single Settings › Terminal notice about what a newer atelierd would bring (never two stacked notices with two
 * restart buttons): true = available. Null when nothing is missing.
 */
export function restartNotice(has: { profiles: boolean; states2: boolean; ports: boolean; background?: boolean; aliases?: boolean; names?: boolean }): string | null {
  const s = t.set;
  if (has.ports) {
    if (!has.profiles && !has.states2) return s.bothNeedRestart;
    if (!has.profiles) return s.profilesNeedRestart;
    if (!has.states2) return s.states2NeedRestart;
    // Background work, aliases and session name sync only when nothing else is missing: the
    // restart above brings them too.
    if (has.background === false) return has.aliases === false ? s.backgroundAliasesNeedRestart : s.backgroundNeedsRestart;
    if (has.aliases === false) return s.aliasesNeedRestart;
    return has.names === false ? s.namesNeedRestart : null;
  }
  if (!has.profiles && !has.states2) return s.allNeedRestart;
  if (!has.profiles) return s.profilesPortsNeedRestart;
  if (!has.states2) return s.states2PortsNeedRestart;
  return s.portsNeedRestart;
}
