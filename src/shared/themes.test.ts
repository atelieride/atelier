import { expect, test } from 'vitest';
import base from '../renderer/theme.css?raw';
import others from '../renderer/themes.css?raw';
import docsy from '../renderer/themes-docsy.css?raw';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings';
import { parseThemeCss } from './theme-resolve';
import { chromeColors, terminalTheme, themeArg, themeFromArgv, THEMES, themeOf } from './themes';

test('eight themes, Aurora first and the default, the dark Aurora-likes next, Docsy\'s pair last; each light theme names its dark twin', () => {
  expect(THEMES.map((t) => [t.id, t.appearance, t.dark])).toEqual([
    ['aurora', 'dark', 'aurora'], ['ember', 'dark', 'ember'], ['tide', 'dark', 'tide'],
    ['daylight', 'light', 'aurora'], ['ink', 'dark', 'ink'], ['paper', 'light', 'ink'],
    ['docsy', 'light', 'docsy-night'], ['docsy-night', 'dark', 'docsy-night']
  ]);
  expect(THEMES.map((t) => t.name)).toEqual(['Aurora', 'Ember', 'Tide', 'Daylight', 'Minimal · Ink', 'Minimal · Paper', 'Docsy', 'Docsy Night']);
  expect(DEFAULT_SETTINGS.theme).toBe('aurora');
  expect(DEFAULT_SETTINGS.terminalColors).toBe('theme');
});

test('an unknown theme (one removed later, a hand-edited file) reads as Aurora', () => {
  expect(themeOf('nope').id).toBe('aurora');
  expect(normalizeSettings({ theme: 'nope' }).theme).toBe('aurora');
  expect(normalizeSettings({ theme: 'paper', terminalColors: 'dark' })).toMatchObject({ theme: 'paper', terminalColors: 'dark' });
  expect(normalizeSettings({ terminalColors: 'neon' }).terminalColors).toBe('theme');
});

test('"Always dark" gives a light theme\'s terminals its dark twin; a dark theme keeps its own', () => {
  expect(terminalTheme('daylight', 'dark')).toBe('aurora');
  expect(terminalTheme('paper', 'dark')).toBe('ink');
  expect(terminalTheme('paper', 'theme')).toBe('paper');
  expect(terminalTheme('ink', 'dark')).toBe('ink');
  expect(terminalTheme('ember', 'dark')).toBe('ember');
  expect(terminalTheme('docsy', 'dark')).toBe('docsy-night');
  expect(terminalTheme('docsy-night', 'dark')).toBe('docsy-night');
});

test('the window paints the theme\'s --bg-0 before the page loads; Windows\' caption symbols are its --text-2', () => {
  const blocks = parseThemeCss(`${base}\n${others}\n${docsy}`);
  expect(chromeColors(blocks, 'aurora')).toEqual({ background: '#08080F', symbol: '#C9C7E6' });
  expect(chromeColors(blocks, 'ember')).toEqual({ background: '#0E0A08', symbol: '#DDCDBF' });
  expect(chromeColors(blocks, 'tide')).toEqual({ background: '#050B0E', symbol: '#BCD6DC' });
  expect(chromeColors(blocks, 'docsy')).toEqual({ background: '#F5F6F8', symbol: '#3D434E' });
  expect(chromeColors(blocks, 'docsy-night')).toEqual({ background: '#0A1324', symbol: '#C3C9D4' });
});

test('the theme a window opens on travels as a launch argument; anything else reads as Aurora', () => {
  expect(themeArg('paper')).toBe('--atelier-theme=paper');
  expect(themeFromArgv(['electron', '--foo', '--atelier-theme=paper'])).toBe('paper');
  expect(themeFromArgv(['--atelier-theme=docsy-night'])).toBe('docsy-night');
  expect(themeFromArgv(['--atelier-theme=nope'])).toBe('aurora');
  expect(themeFromArgv([])).toBe('aurora');
});
