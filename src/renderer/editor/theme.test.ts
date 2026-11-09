import { expect, test } from 'vitest';
import { resolveToken } from '@shared/theme-resolve';
import { THEME_BLOCKS as blocks } from '../theme-source';
import { atelierTheme, DEFAULT_FG } from './theme';

// Themes: the syntax colors are theme tokens; in Aurora they are the colors they always were.
const OLD = ['#6E6C94', '#F472B6', '#F9A8D4', '#86EFAC', '#FDBA74', '#7DD3FC', '#FDE68A', '#C4B5FD', '#A5B4FC', '#FCD34D', '#8A88AD',
  '#F472B6', undefined, undefined, '#A5B4FC', '#34D399', '#FB7185', '#FCD34D'];

test('every syntax color is a --syn-* token that resolves, in Aurora, to the color it had', () => {
  const fg = atelierTheme.tokenColors!.map((t) => t.settings.foreground);
  expect(fg.length).toBe(OLD.length);
  fg.forEach((f, i) => {
    if (OLD[i] === undefined) { expect(f, String(i)).toBeUndefined(); return; }
    expect(f, String(i)).toMatch(/^var\(--syn-[\w-]+\)$/);
    expect(resolveToken(blocks, 'aurora', f!.slice(4, -1)), f).toBe(OLD[i]);
  });
  expect(DEFAULT_FG).toBe('var(--editor-fg)');
  expect(resolveToken(blocks, 'aurora', '--editor-fg')).toBe('#E4E2F7');
});
