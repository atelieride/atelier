import { currentPlatform, type Platform } from '@shared/platform';

// Views a platform has. The tmux Services view is hidden on Windows (decided: tmux is a macOS
// and Linux tool; the rail, the palette and the menu leave it out there), and elsewhere until turned on in Settings ›
// Appearance (2026-11-02: few people use tmux). `on`: settings.showServices.
export function servicesView(on: boolean, platform: Platform = currentPlatform()): boolean {
  return on && platform !== 'win32';
}

/** The `atelier` shell command (a symlink in /usr/local/bin): macOS's; Windows would need an App Execution Alias. */
export function shellCommand(platform: Platform = currentPlatform()): boolean {
  return platform !== 'win32';
}

/** The zsh environment capture (Reload Shell Environment, auto-reload): Windows terminals start without one. */
export function shellEnv(platform: Platform = currentPlatform()): boolean {
  return platform !== 'win32';
}
