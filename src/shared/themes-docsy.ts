import type { ThemeInfo } from './themes';

/**
 * Docsy's pair: its blue and gold, its type; the light one keeps terminals dark with Night's colors.
 * A module of its own, like their stylesheet (themes-docsy.css): the website's live demo swaps both for empty ones
 * (src/demo/compile/build.ts), so the company's name never reaches the site.
 */
export const DOCSY_THEMES: readonly ThemeInfo[] = [
  { id: 'docsy', name: 'Docsy', appearance: 'light', dark: 'docsy-night' },
  { id: 'docsy-night', name: 'Docsy Night', appearance: 'dark', dark: 'docsy-night' }
];
