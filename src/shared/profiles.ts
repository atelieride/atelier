import type { TerminalProfile } from './protocol';
import { isAbsPath } from './paths';
import { pathStyle } from './platform';

/**
 * Terminal profiles as the app stores and passes them: 'atelier', 'user' (zsh with the user's config) or the absolute
 * path of a shell listed in /etc/shells. The protocol form ({ shell }) is built only when talking to atelierd.
 */
export type ProfileKey = string;

/** A shell offered as a profile (from /etc/shells): name is what menus and chips show. */
export interface ShellOption { path: string; name: string }

export const PROFILE_PATH_MAX = 4096;

export function isProfileKeyShape(v: unknown): v is ProfileKey {
  return typeof v === 'string' && (v === 'atelier' || v === 'user' || (isAbsPath(v) && v.length > 1 && v.length <= PROFILE_PATH_MAX));
}

export function profileKeyOf(p: TerminalProfile | undefined): ProfileKey | null {
  if (p === undefined) return null;
  return typeof p === 'string' ? p : p.shell;
}

/**
 * The profile a new terminal is created with: the one asked for (menu, palette) or the default setting.
 * undefined when atelierd lacks the profiles capability: an older atelierd gets exactly today's request.
 * A shell asked for must be one the app offers; a default that is no longer listed falls back to Atelier.
 */
export function terminalProfile(requested: ProfileKey | undefined, setting: ProfileKey, shells: readonly string[], capable: boolean): TerminalProfile | undefined {
  if (!capable) return undefined;
  if (requested !== undefined) {
    if (requested === 'atelier' || requested === 'user') return requested;
    if (shells.includes(requested)) return { shell: requested };
    throw new Error('profile not available');
  }
  if (setting === 'atelier' || setting === 'user') return setting;
  return shells.includes(setting) ? { shell: setting } : 'atelier';
}

/**
 * The profile of a new or resumed Claude session. Only the two zsh profiles: they define the `claude` function that
 * passes Atelier's hooks (a plain shell would run Claude without them), so a shell default keeps sessions on Atelier.
 */
export function sessionProfile(setting: ProfileKey, capable: boolean): 'atelier' | 'user' | undefined {
  if (!capable) return undefined;
  return setting === 'user' ? 'user' : 'atelier';
}

/**
 * What create/resume say about the user's aliases: only `aliases: false`, and only to an atelierd with the 'aliases'
 * capability (absent = imported; an older atelierd gets the requests it always got).
 */
export function aliasesOption(setting: boolean, capable: boolean): { aliases?: false } {
  return capable && !setting ? { aliases: false } : {};
}

const MAC_NAMES: Record<'atelier' | 'user', { label: string; chip: string }> = {
  atelier: { label: 'Atelier', chip: 'Atelier' },
  user: { label: 'zsh (your config)', chip: 'zsh' }
};
/** Windows: both built-in profiles are PowerShell; "user" loads your $PROFILE as zsh's loads .zshrc. */
const WINDOWS_NAMES: typeof MAC_NAMES = {
  atelier: { label: 'Atelier', chip: 'Atelier' },
  user: { label: 'PowerShell (your profile)', chip: 'PowerShell' }
};
const names = () => (pathStyle() === 'win32' ? WINDOWS_NAMES : MAC_NAMES);

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

/** Every profile a new terminal can use, in menu order. */
export function profileOptions(shells: readonly ShellOption[]): { key: ProfileKey; label: string }[] {
  return [
    { key: 'atelier', label: names().atelier.label },
    { key: 'user', label: names().user.label },
    ...shells.map((s) => ({ key: s.path, label: s.name }))
  ];
}

export function profileLabel(key: ProfileKey, shells: readonly ShellOption[]): string {
  if (key === 'atelier' || key === 'user') return names()[key].label;
  return shells.find((s) => s.path === key)?.name ?? baseName(key);
}

/** The short form shown in a row or tab chip. */
export function profileChip(key: ProfileKey, shells: readonly ShellOption[]): string {
  return key === 'atelier' || key === 'user' ? names()[key].chip : profileLabel(key, shells);
}

/**
 * The chip of a terminal or session row: its profile, only when it differs from the default its kind starts with
 * now (terminals: the setting; sessions: Atelier or zsh). Nothing for terminals of an older atelierd.
 */
export function chipFor(term: { profile?: TerminalProfile; session: boolean }, setting: ProfileKey, shells: readonly ShellOption[]): string | null {
  const key = profileKeyOf(term.profile);
  if (key === null) return null;
  const def = term.session ? sessionProfile(setting, true)! : profileKeyOf(terminalProfile(undefined, setting, shells.map((s) => s.path), true));
  return key === def ? null : profileChip(key, shells);
}
