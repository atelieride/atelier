// Every theme's tokens as text (theme.css is Aurora and the base, themes.css and themes-docsy.css the others), parsed
// once for what needs finished colors in the renderer: xterm's theme, the task tones (shared/theme-resolve.ts).
import base from './theme.css?raw';
import others from './themes.css?raw';
import docsy from './themes-docsy.css?raw';
import { parseThemeCss } from '@shared/theme-resolve';

export const THEME_BLOCKS = parseThemeCss(`${base}\n${others}\n${docsy}`);
