import { expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { applyDocumentSettings, fadesThemeSwitch, terminalOptions } from './settings-apply';
import { xtermTheme } from './terminal/xtermTheme';
import { resolveToken } from '@shared/theme-resolve';
import { THEME_BLOCKS } from './theme-source';

test('xterm options from settings', () => {
  expect(terminalOptions(DEFAULT_SETTINGS)).toEqual({ fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontSize: 13, lineHeight: 1.2, cursorStyle: 'bar', cursorBlink: true, macOptionIsMeta: false, scrollback: 10000, theme: xtermTheme('aurora'), minimumContrastRatio: 1 });
  const o = terminalOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 16, cursorStyle: 'block', cursorBlink: false, optionAsMeta: true, scrollback: 50000, terminalLineHeight: 1.4 });
  expect(o).toMatchObject({ fontSize: 16, lineHeight: 1.4, cursorStyle: 'block', cursorBlink: false, macOptionIsMeta: true, scrollback: 50000 });
});

test('the terminal font: xterm draws with its stack, CSS reads it from --term-font', () => {
  expect(terminalOptions({ ...DEFAULT_SETTINGS, terminalFontFamily: 'Fira Code' }).fontFamily).toBe("\"Fira Code\", 'JetBrains Mono', ui-monospace, Menlo, monospace");
  const { props, el } = fakeRoot();
  applyDocumentSettings(DEFAULT_SETTINGS, el);
  expect(props['--term-font']).toBe("'JetBrains Mono', ui-monospace, Menlo, monospace");
  applyDocumentSettings({ ...DEFAULT_SETTINGS, terminalFontFamily: 'Menlo' }, el);
  expect(props['--term-font']).toBe("\"Menlo\", 'JetBrains Mono', ui-monospace, Menlo, monospace");
});

test('the terminal theme: the theme\'s, its dark twin with "Always dark"; light terminals keep any text readable', () => {
  expect(terminalOptions({ ...DEFAULT_SETTINGS, theme: 'paper' })).toMatchObject({ theme: xtermTheme('paper'), minimumContrastRatio: 4.5 });
  expect(terminalOptions({ ...DEFAULT_SETTINGS, theme: 'paper', terminalColors: 'dark' })).toMatchObject({ theme: xtermTheme('ink'), minimumContrastRatio: 1 });
  expect(terminalOptions({ ...DEFAULT_SETTINGS, theme: 'ink', terminalColors: 'dark' })).toMatchObject({ theme: xtermTheme('ink'), minimumContrastRatio: 1 });
  // The same object while the theme stays: other settings don't make every terminal redraw.
  expect(terminalOptions(DEFAULT_SETTINGS).theme).toBe(terminalOptions({ ...DEFAULT_SETTINGS, terminalFontSize: 15 }).theme);
});

function fakeRoot() {
  const props: Record<string, string> = {};
  const el = { style: { setProperty: (k: string, v: string) => { props[k] = v; }, removeProperty: (k: string) => { delete props[k]; return ''; } }, dataset: {} as Record<string, string | undefined> };
  return { props, el };
}

test('documento: grandezza dell editor, interlinea e movimento', () => {
  const { props, el } = fakeRoot();
  applyDocumentSettings(DEFAULT_SETTINGS, el);
  expect(props['--editor-font-size']).toBe('13px');
  expect(props['--editor-line-height']).toBe('21px');
  expect(el.dataset.motion).toBeUndefined();
  applyDocumentSettings({ ...DEFAULT_SETTINGS, editorFontSize: 16, motion: 'reduced' }, el);
  expect(props['--editor-font-size']).toBe('16px');
  expect(props['--editor-line-height']).toBe('26px');
  expect(el.dataset.motion).toBe('reduced');
  applyDocumentSettings(DEFAULT_SETTINGS, el);
  expect(el.dataset.motion).toBeUndefined();
});

test('the theme on <html>: none for Aurora (it is :root), data-theme for the others', () => {
  const { el } = fakeRoot();
  applyDocumentSettings({ ...DEFAULT_SETTINGS, theme: 'paper' }, el);
  expect(el.dataset.theme).toBe('paper');
  applyDocumentSettings(DEFAULT_SETTINGS, el);
  expect(el.dataset.theme).toBeUndefined();
});

test('"Always dark" with a light theme: the twin\'s terminal colors on <html>, gone again when terminals follow', () => {
  const { props, el } = fakeRoot();
  applyDocumentSettings({ ...DEFAULT_SETTINGS, theme: 'paper', terminalColors: 'dark' }, el);
  expect(props['--term-bg']).toBe(xtermTheme('ink').background);
  expect(props['--term-fg']).toBe(xtermTheme('ink').foreground);
  expect(props['--term-cursor']).toBe(xtermTheme('ink').cursor);
  applyDocumentSettings({ ...DEFAULT_SETTINGS, theme: 'paper' }, el);
  expect(props['--term-bg']).toBeUndefined();
  expect(props['--term-fg']).toBeUndefined();
});

test('a theme switch fades: only when the theme changes and motion is not reduced', () => {
  expect(fadesThemeSwitch('aurora', 'paper', false)).toBe(true);
  expect(fadesThemeSwitch('paper', 'paper', false)).toBe(false);
  expect(fadesThemeSwitch('aurora', 'paper', true)).toBe(false);
});

test('"Always dark": the terminal preview\'s accents are the twin\'s too, gone when terminals follow', () => {
  const { props, el } = fakeRoot();
  applyDocumentSettings({ ...DEFAULT_SETTINGS, theme: 'daylight', terminalColors: 'dark' }, el);
  for (const [inline, token] of [['--tp-violet', '--preview-violet'], ['--tp-pink', '--preview-pink'], ['--tp-sky', '--preview-sky'], ['--tp-amber', '--preview-amber'], ['--tp-dim', '--text-4']]) {
    expect(props[inline!], inline).toBe(resolveToken(THEME_BLOCKS, 'aurora', token!));
  }
  applyDocumentSettings({ ...DEFAULT_SETTINGS, theme: 'daylight' }, el);
  expect(props['--tp-violet']).toBeUndefined();
});
