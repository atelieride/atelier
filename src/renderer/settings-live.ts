import type { Settings } from '@shared/settings';
import type { ThemeId } from '@shared/themes';
import { applyTerminalSettings } from './terminal/registry';
import { applyDocumentSettings, fadesThemeSwitch } from './settings-apply';
import { loadThemeFonts } from './fonts';
import { useApp } from './store';

/** New settings from main: first to xterm and the document, then to the store (which makes the view refit). */
export function adoptSettings(s: Settings): void {
  // A theme or font being previewed stays on screen when other settings arrive meanwhile.
  const shown = shownOf(s);
  fadeFrom(shown);
  applyTerminalSettings(shown);
  applyDocumentSettings(shown, document.documentElement);
  void loadThemeFonts();
  useApp.getState().setSettings(s);
  // A kept font: these settings carry it, the preview's name can go (keepFontPreview left it for the tag and the refit).
  if (!previewingFont && useApp.getState().fontPreview !== null) useApp.getState().setFontPreview(null);
}

let previewing: ThemeId | null = null;
let previewingFont: string | null = null;

/** The settings on screen: the saved ones, with the theme or terminal font a sheet is previewing on top. */
function shownOf(s: Settings): Settings {
  return { ...s, ...(previewing ? { theme: previewing } : {}), ...(previewingFont ? { terminalFontFamily: previewingFont } : {}) };
}

let fadeEnds: ReturnType<typeof setTimeout> | null = null;

/** Marks <html> for a short cross-fade when the theme on screen is about to change (layout.css, [data-theme-fade]). */
function fadeFrom(next: Settings): void {
  const root = document.documentElement;
  const shown = root.dataset.theme ?? 'aurora';
  const reduced = root.dataset.motion === 'reduced' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fadesThemeSwitch(shown, next.theme, reduced)) return;
  root.dataset.themeFade = '';
  if (fadeEnds) clearTimeout(fadeEnds);
  fadeEnds = setTimeout(() => { delete root.dataset.themeFade; fadeEnds = null; }, 260);
}

/**
 * Change Theme…: shows a theme on the document and every terminal without saving it; null goes
 * back to the theme in the settings.
 */
export function previewTheme(theme: ThemeId | null): void {
  previewing = theme;
  const shown = shownOf(useApp.getState().settings);
  fadeFrom(shown);
  applyTerminalSettings(shown);
  applyDocumentSettings(shown, document.documentElement);
  void loadThemeFonts();
}

/** The previewed theme was kept (saved): it stays on screen, and the settings main sends back carry it. */
export function keepPreview(): void {
  previewing = null;
}

/**
 * The terminal font pickers: shows a font on every terminal of the window and in Settings'
 * preview without saving it; null goes back to the font in the settings. Terminals refit through the store's
 * fontPreview.
 */
export function previewTerminalFont(family: string | null): void {
  previewingFont = family;
  const shown = shownOf(useApp.getState().settings);
  applyTerminalSettings(shown);
  applyDocumentSettings(shown, document.documentElement);
  useApp.getState().setFontPreview(family);
}

/** The previewed font was kept: it stays on screen, its name in the store too, until main sends the saved settings back. */
export function keepFontPreview(): void {
  previewingFont = null;
}
