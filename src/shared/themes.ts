// Themes: which exist, and what main and the terminals need to know of each. Their
// colors live only in theme.css (`:root` is Aurora, `:root[data-theme="<id>"]` the others), read through
// theme-resolve.ts.
import { resolveToken, type ThemeBlocks } from './theme-resolve';
import { DOCSY_THEMES } from './themes-docsy';

export type ThemeId = 'aurora' | 'ember' | 'tide' | 'daylight' | 'ink' | 'paper' | 'docsy' | 'docsy-night';
export type Appearance = 'dark' | 'light';
/** Settings › Appearance › Terminal colors: follow the theme, or keep a light theme's terminals dark. */
export type TerminalColors = 'theme' | 'dark';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  appearance: Appearance;
  /** The dark theme whose terminals a light one borrows with "Always dark" (a dark theme: itself). */
  dark: ThemeId;
}

export const THEMES: readonly ThemeInfo[] = [
  { id: 'aurora', name: 'Aurora', appearance: 'dark', dark: 'aurora' },
  { id: 'ember', name: 'Ember', appearance: 'dark', dark: 'ember' },
  { id: 'tide', name: 'Tide', appearance: 'dark', dark: 'tide' },
  { id: 'daylight', name: 'Daylight', appearance: 'light', dark: 'aurora' },
  { id: 'ink', name: 'Minimal · Ink', appearance: 'dark', dark: 'ink' },
  { id: 'paper', name: 'Minimal · Paper', appearance: 'light', dark: 'ink' },
  ...DOCSY_THEMES
];
export const THEME_IDS = THEMES.map((t) => t.id);

/** A theme by id; anything else (a theme removed later, a hand-edited file) is Aurora. */
export function themeOf(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** The theme a terminal takes its colors from. */
export function terminalTheme(id: ThemeId, colors: TerminalColors): ThemeId {
  const t = themeOf(id);
  return colors === 'dark' && t.appearance === 'light' ? t.dark : t.id;
}

/** What main paints itself: the window before the page loads (--bg-0), Windows' caption buttons (--text-2). */
export function chromeColors(blocks: ThemeBlocks, id: ThemeId): { background: string; symbol: string } {
  return { background: resolveToken(blocks, id, '--bg-0'), symbol: resolveToken(blocks, id, '--text-2') };
}

const ARG = '--atelier-theme=';

/** The launch argument that tells a window's page its theme before its first paint (the preload reads it). */
export function themeArg(id: ThemeId): string {
  return `${ARG}${id}`;
}

/** The theme a page was opened on, from its process arguments; Aurora without one. */
export function themeFromArgv(argv: readonly string[]): ThemeId {
  const a = argv.find((x) => x.startsWith(ARG));
  return themeOf(a ? a.slice(ARG.length) : '').id;
}
