import type { Platform } from '@shared/platform';
import { t } from './i18n/en';

// The session icons' words: what macOS's menu bar and Windows' notification area each
// show differs (a dot per session, one icon), so each platform has its own sentences rather than a word swap.

export function trayCopy(platform: Platform): { label: string; hint: string; command: string } {
  return platform === 'win32'
    ? { label: t.set.trayIconsWin, hint: t.set.trayIconsHintWin, command: t.cmd.toggleTrayIconsWin }
    : { label: t.set.trayIcons, hint: t.set.trayIconsHint, command: t.cmd.toggleTrayIcons };
}
