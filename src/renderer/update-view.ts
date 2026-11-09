// What Settings › About and the footer show for the in-app updater (status from main, see @shared/update-feed).
import { currentPlatform } from '@shared/platform';
import type { UpdateChannel, UpdateChannelSetting, UpdateStatus } from '@shared/update-feed';
import { t } from './i18n/en';

export type UpdateTone = 'ok' | 'warn' | 'err' | 'idle' | 'busy';

export interface UpdateSummary {
  tone: UpdateTone;
  title: string;
  detail?: string;
  /** 0..1 while downloading. */
  progress?: number;
  action?: 'restart' | 'release-page' | 'applications' | 'store';
  /** Windows: the site's changelog next to Restart (what the registered version brings). */
  changelog?: true;
}

/**
 * On Windows the Microsoft Store updates the app: no channel; Atelier asks the Store and shows
 * what it says.
 */
export function storeUpdates(): boolean {
  return currentPlatform() === 'win32';
}

/** What follows the version in Settings › About: the channel checked, "Development build", or nothing (the Store's). */
export function versionChannel(s: UpdateStatus | null): string | null {
  if (!s || storeUpdates()) return null;
  if (s.channel) return t.upd.channelLabel(t.upd.channels[s.channel]);
  return s.available ? null : t.upd.devLabel;
}

/** Settings › About channel control: "Auto" follows the build's own channel (none for dev and stage-update builds). */
export function channelOptions(buildChannel: UpdateChannel | null): { value: UpdateChannelSetting; label: string }[] {
  return [
    { value: 'auto', label: t.upd.auto(t.upd.channels[buildChannel ?? 'off']) },
    { value: 'off', label: t.upd.channels.off },
    { value: 'stable', label: t.upd.channels.stable },
    { value: 'beta', label: t.upd.channels.beta }
  ];
}

export function checkedAgo(lastCheck: number | null, now: number): string {
  if (lastCheck === null) return t.upd.never;
  const min = Math.floor(Math.max(0, now - lastCheck) / 60_000);
  if (min < 1) return t.upd.justNow;
  if (min < 60) return t.upd.minAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.upd.hAgo(h);
  const d = Math.floor(h / 24);
  return d === 1 ? t.upd.yesterday : t.upd.daysAgo(d);
}

/** Windows: the Microsoft Store's updates. */
function storeSummary(s: UpdateStatus): UpdateSummary {
  const p = s.phase;
  if (!s.available) return { tone: 'idle', title: t.upd.store, detail: t.upd.storeDetail };
  switch (p.kind) {
    case 'checking': return { tone: 'busy', title: t.upd.storeChecking };
    case 'up-to-date': return { tone: 'ok', title: t.upd.upToDate };
    case 'downloading': {
      const progress = p.total > 0 ? Math.min(1, p.received / p.total) : 0;
      return { tone: 'busy', title: t.upd.storeInstalling(Math.floor(progress * 100)), progress };
    }
    // No version when Windows staged it until Atelier closes.
    case 'ready': return { tone: 'ok', title: p.version ? t.upd.ready(p.version) : t.upd.storeReady, detail: t.upd.readyDetail, action: 'restart', changelog: true };
    case 'store': return { tone: 'warn', title: t.upd.storeAvailable, detail: t.upd.storeAvailableDetail[p.reason], action: 'store' };
    case 'error':
      if (p.error === 'store-download') return { tone: 'warn', title: t.upd.storeInstallFailed, detail: t.upd.storeInstallFailedDetail[p.message] ?? t.upd.storeInstallFailedDetail.other!, action: 'store' };
      return { tone: 'warn', title: t.upd.storeCheckFailed, detail: t.upd.storeCheckFailedDetail };
    default: return { tone: 'idle', title: t.upd.notChecked };
  }
}

export function updateSummary(s: UpdateStatus): UpdateSummary {
  if (storeUpdates()) return storeSummary(s);
  const p = s.phase;
  switch (p.kind) {
    case 'idle':
      if (!s.available) return { tone: 'idle', title: t.upd.devBuild, detail: t.upd.devBuildDetail };
      if (!s.channel) return { tone: 'idle', title: t.upd.off, detail: t.upd.offDetail };
      return { tone: 'idle', title: t.upd.notChecked };
    case 'checking': return { tone: 'busy', title: t.upd.checking };
    case 'up-to-date': return { tone: 'ok', title: t.upd.upToDate };
    case 'downloading': {
      const progress = p.total > 0 ? Math.min(1, p.received / p.total) : 0;
      return { tone: 'busy', title: t.upd.downloading(p.version, Math.floor(progress * 100)), progress };
    }
    case 'verifying': return { tone: 'busy', title: t.upd.verifying(p.version) };
    case 'ready': return { tone: 'ok', title: t.upd.ready(p.version), detail: t.upd.readyDetail, action: 'restart' };
    case 'needs-restart': return { tone: 'warn', title: t.upd.needsRestart(p.version), detail: t.upd.needsRestartDetail, action: 'release-page' };
    case 'location': return { tone: 'warn', title: t.upd.location, detail: t.upd.locationDetail[p.problem](p.version), action: 'applications' };
    case 'store': return storeSummary(s);
    case 'error': {
      // Connectivity is temporary (amber); a rejected release is an error (rose), never retried on its own.
      const transient = p.error === 'network' || p.error === 'rate-limited';
      if (p.error === 'incomplete') return { tone: 'err', title: t.upd.incomplete, detail: t.upd.errors.incomplete, action: 'release-page' };
      return { tone: transient ? 'warn' : 'err', title: t.upd.failed, detail: t.upd.errors[p.error] ?? p.message };
    }
  }
}

export function canCheck(s: UpdateStatus | null): boolean {
  // Windows has no channel: the Store decides what there is; a ready update has nothing left to ask until the restart.
  if (!s || !s.available || (!s.channel && !storeUpdates())) return false;
  if (storeUpdates() && s.phase.kind === 'ready') return false;
  return !['checking', 'downloading', 'verifying'].includes(s.phase.kind);
}

/** The toast when Restart couldn't apply the update: where to get it by hand on each platform. */
export function updateFailedToast(): { text: string; label: string; target: 'release' | 'store' } {
  if (storeUpdates()) return { text: t.updateFailedStore, label: t.upd.openStore, target: 'store' };
  return { text: t.updateFailed, label: t.upd.openRelease, target: 'release' };
}

/** The palette's "Check for updates": macOS's updater always; on Windows only where the Store can be asked. */
export function offersCheck(s: UpdateStatus | null): boolean {
  return !storeUpdates() || !!s?.available;
}

/**
 * The footer pill: "Update ready · Restart" (staged) or a quieter "Update available" (needs atelierd restarted,
 * Atelier must be moved to Applications first, or, on Windows, the update is the Microsoft Store's to install).
 */
export function footerUpdate(ready: boolean, s: UpdateStatus | null): 'ready' | 'available' | null {
  if (ready) return 'ready';
  return s?.phase.kind === 'needs-restart' || s?.phase.kind === 'location' || s?.phase.kind === 'store' ? 'available' : null;
}
