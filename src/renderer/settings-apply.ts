import type { Settings } from '@shared/settings';
import { terminalTheme, themeOf } from '@shared/themes';
import { xtermTheme } from './terminal/xtermTheme';
import { resolveToken } from '@shared/theme-resolve';
import { THEME_BLOCKS } from './theme-source';
import { fontStack } from '@shared/terminal-font';

/** The xterm options that depend on the settings (they apply to already open terminals too). */
export function terminalOptions(s: Settings) {
  const term = terminalTheme(s.theme, s.terminalColors);
  return {
    fontFamily: fontStack(s.terminalFontFamily), fontSize: s.terminalFontSize, lineHeight: s.terminalLineHeight, cursorStyle: s.cursorStyle,
    cursorBlink: s.cursorBlink, macOptionIsMeta: s.optionAsMeta, scrollback: s.scrollback,
    // On a light terminal, text drawn for a dark one (Claude Code's own colors) stays readable.
    theme: xtermTheme(term), minimumContrastRatio: themeOf(term).appearance === 'light' ? 4.5 : 1
  };
}

interface DocLike { style: { setProperty(k: string, v: string): void; removeProperty(k: string): string }; dataset: Record<string, string | undefined> }

/**
 * What CSS paints terminals with (the slot around xterm, Settings' terminal preview), as inline properties naming the
 * dark twin's token they take with "Always dark" on a light theme.
 */
const TERM_TOKENS = {
  '--term-bg': '--term-bg', '--term-fg': '--term-fg', '--term-cursor': '--term-cursor',
  '--tp-violet': '--preview-violet', '--tp-pink': '--preview-pink', '--tp-sky': '--preview-sky', '--tp-amber': '--preview-amber', '--tp-dim': '--text-4'
} as const;

/** Theme, editor CSS variables and motion preference on the document (<html> root). */
export function applyDocumentSettings(s: Settings, root: DocLike): void {
  root.style.setProperty('--editor-font-size', `${s.editorFontSize}px`);
  // Same proportion as before (13 px on a 21 px line).
  root.style.setProperty('--editor-line-height', `${Math.round(s.editorFontSize * 1.6)}px`);
  // What CSS draws terminal text with outside xterm (Settings' preview, command blocks' sticky line).
  root.style.setProperty('--term-font', fontStack(s.terminalFontFamily));
  if (s.motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  // Aurora is :root itself; the others are :root[data-theme] blocks in theme.css.
  const theme = themeOf(s.theme).id;
  if (theme === 'aurora') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const term = terminalTheme(theme, s.terminalColors);
  for (const [inline, token] of Object.entries(TERM_TOKENS)) {
    if (term === theme) root.style.removeProperty(inline);
    else root.style.setProperty(inline, resolveToken(THEME_BLOCKS, term, token));
  }
}

/** A theme switch cross-fades the page's colors, unless motion is reduced. */
export function fadesThemeSwitch(from: string, to: string, reducedMotion: boolean): boolean {
  return from !== to && !reducedMotion;
}
