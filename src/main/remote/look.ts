// How Atelier looks, as a phone gets it to dress like this computer: the theme in use, the terminal's settings, and
// every theme with its colors finished (hex only: a phone reads no CSS, no var(), no color-mix). Pure.
import type { Settings } from '@shared/settings';
import { resolveHex, type ThemeBlocks } from '@shared/theme-resolve';
import { THEMES, themeOf } from '@shared/themes';
import type { RemoteLook, RemoteTheme } from './messages';

const numbered = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${from + i}`);

/** The tokens each theme carries (names without their `--`): the interface's, then the terminal's. */
export const LOOK_TOKENS: readonly string[] = [
  'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-float', 'line', 'line-soft', 'line-strong',
  'text', 'text-2', 'text-3', 'text-4', 'text-error', 'link',
  'violet', 'violet-soft', 'violet-light', 'pink', 'on-brand',
  'waiting', 'working', 'done', 'error',
  ...numbered('ws', 1, 8), ...numbered('person', 1, 8),
  'worktree', 'worktree-text', 'abyss',
  'term-bg', 'term-fg', 'term-cursor', 'term-sel', ...numbered('ansi', 0, 15)
];

/** The settings the look reads: a change to any other one leaves it as it was. */
export const LOOK_SETTINGS = ['theme', 'terminalColors', 'terminalFontFamily', 'terminalFontSize', 'terminalLineHeight', 'cursorStyle', 'cursorBlink'] as const satisfies readonly (keyof Settings)[];

// The themes depend on the CSS alone, which never changes while the app runs: resolved once per set of blocks.
const resolved = new WeakMap<ThemeBlocks, RemoteTheme[]>();

function remoteThemes(blocks: ThemeBlocks): RemoteTheme[] {
  let themes = resolved.get(blocks);
  if (!themes) {
    themes = THEMES.map((t) => ({
      id: t.id, name: t.name, appearance: t.appearance, dark: t.dark,
      colors: Object.fromEntries(LOOK_TOKENS.map((k) => [k, resolveHex(blocks, t.id, `--${k}`)]))
    }));
    resolved.set(blocks, themes);
  }
  return themes;
}

export function remoteLook(s: Settings, blocks: ThemeBlocks): RemoteLook {
  return {
    theme: themeOf(s.theme).id,
    terminalColors: s.terminalColors,
    terminal: { font: s.terminalFontFamily, size: s.terminalFontSize, lineHeight: s.terminalLineHeight, cursor: s.cursorStyle, blink: s.cursorBlink },
    themes: remoteThemes(blocks)
  };
}

/** What a look is compared by: equal, it isn't sent again. Its themes are left out, as they never change. */
export function lookKey(l: RemoteLook): string {
  return JSON.stringify([l.theme, l.terminalColors, l.terminal]);
}
