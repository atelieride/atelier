import type { ITheme } from '@xterm/xterm';
import { resolveToken } from '@shared/theme-resolve';
import { THEME_BLOCKS as blocks } from '../theme-source';

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

const made = new Map<string, ITheme>();

/**
 * A theme's terminal colors (its `--term-*` and `--ansi-*` tokens): the work area's background, so the terminal is part
 * of the app. One object per theme: handing a terminal the same one again doesn't redraw it.
 */
export function xtermTheme(theme: string): ITheme {
  let out = made.get(theme);
  if (!out) { out = build(theme); made.set(theme, out); }
  return out;
}

function build(theme: string): ITheme {
  const t = (name: string) => resolveToken(blocks, theme, name);
  const out: ITheme = {
    background: t('--term-bg'), foreground: t('--term-fg'), cursor: t('--term-cursor'), cursorAccent: t('--term-cursor-accent'),
    selectionBackground: t('--term-sel'), selectionInactiveBackground: t('--term-sel-inactive'),
    scrollbarSliderBackground: t('--term-scroll'), scrollbarSliderHoverBackground: t('--term-scroll-hover'), scrollbarSliderActiveBackground: t('--term-scroll-active'),
    // The overview ruler (Find's ticks over the scrollbar) would draw a full-height line at its
    // left edge, in xterm's default foreground, in every terminal: transparent (resolved as rgba, which xterm parses).
    overviewRulerBorder: t('--term-ruler-edge')
  };
  ANSI.forEach((k, i) => { out[k] = t(`--ansi-${i}`); });
  return out;
}
