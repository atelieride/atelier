import { profileOptions, type ProfileKey, type ShellOption } from '@shared/profiles';
import type { MenuItem } from './menu-model';
import { t } from './i18n/en';

/** "+" menu: Terminal with Profile › every profile, the default marked. Disabled while atelierd is older than profiles. */
export function profileSubmenu(shells: readonly ShellOption[], available: boolean, current: ProfileKey, run: (key: ProfileKey) => void): MenuItem & object {
  return {
    id: 'terminal-profile', label: t.menu.terminalWithProfile, icon: 'terminal', disabled: !available, run: () => {},
    submenu: profileOptions(shells).map((p) => ({ id: `profile-${p.key}`, label: p.label, hint: p.key === current ? t.profileDefault : undefined, run: () => run(p.key) }))
  };
}

/** Palette: one "New terminal: <profile>" command per profile (none while atelierd is older than profiles). */
export function paletteProfileCommands(shells: readonly ShellOption[], available: boolean): { key: string; label: string; profile: ProfileKey }[] {
  if (!available) return [];
  return profileOptions(shells).map((p) => ({ key: `new-terminal-profile:${p.key}`, label: t.cmd.newTerminalWith(p.label), profile: p.key }));
}
