// The colors main paints itself: the window before its page loads, Windows' caption buttons. Read
// from theme.css, themes.css and themes-docsy.css, as everything else.
import base from '../renderer/theme.css?raw';
import others from '../renderer/themes.css?raw';
import docsy from '../renderer/themes-docsy.css?raw';
import { parseThemeCss } from '@shared/theme-resolve';
import { chromeColors, type ThemeId } from '@shared/themes';

const blocks = parseThemeCss(`${base}\n${others}\n${docsy}`);

export function chromeOf(theme: ThemeId): { background: string; symbol: string } {
  return chromeColors(blocks, theme);
}
