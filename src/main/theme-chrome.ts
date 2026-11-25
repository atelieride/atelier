// The themes' tokens as main reads them, from theme.css, themes.css and themes-docsy.css as everything else: the colors
// main paints itself (the window before its page loads, Windows' caption buttons) and the themes phones get
// (remote/look.ts).
import base from '../renderer/theme.css?raw';
import others from '../renderer/themes.css?raw';
import docsy from '../renderer/themes-docsy.css?raw';
import { parseThemeCss } from '@shared/theme-resolve';
import { chromeColors, type ThemeId } from '@shared/themes';

/** Every theme's token declarations, parsed once: they are built into the app and never change while it runs. */
export const THEME_BLOCKS = parseThemeCss(`${base}\n${others}\n${docsy}`);

export function chromeOf(theme: ThemeId): { background: string; symbol: string } {
  return chromeColors(THEME_BLOCKS, theme);
}
