import { expect, test } from 'vitest';
import { contrast } from '../contrast';
import { xtermTheme } from './xtermTheme';

test('WCAG contrast ratio', () => {
  expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21);
  expect(contrast('#10101C', '#10101C')).toBeCloseTo(1);
});

test('Aurora terminal, read from the theme tokens: the colors it always had', () => {
  expect(xtermTheme('aurora')).toEqual({
    background: '#10101C', foreground: '#E4E2F7', cursor: '#C4B5FD', cursorAccent: '#10101C',
    selectionBackground: 'rgba(139,92,246,0.35)', selectionInactiveBackground: 'rgba(139,92,246,0.18)',
    scrollbarSliderBackground: 'rgba(163,161,196,0.18)', scrollbarSliderHoverBackground: 'rgba(163,161,196,0.32)', scrollbarSliderActiveBackground: 'rgba(163,161,196,0.45)',
    // The overview ruler (Find's ticks) draws a full-height line at its left edge: none.
    overviewRulerBorder: 'rgba(0,0,0,0)',
    black: '#24243A', red: '#FB7185', green: '#34D399', yellow: '#FBBF24', blue: '#60A5FA', magenta: '#C084FC', cyan: '#22D3EE', white: '#C9C7E6',
    brightBlack: '#7E7CA3', brightRed: '#FDA4AF', brightGreen: '#6EE7B7', brightYellow: '#FDE68A', brightBlue: '#93C5FD', brightMagenta: '#F0ABFC', brightCyan: '#67E8F9', brightWhite: '#F5F4FF'
  });
});

test('Aurora terminal: work-area background, readable colors', () => {
  const theme = xtermTheme('aurora');
  const bg = theme.background!;
  expect(contrast(theme.foreground!, bg)).toBeGreaterThanOrEqual(7);
  const keys = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;
  for (const k of keys) expect(contrast(theme[k]!, bg), k).toBeGreaterThanOrEqual(3);
});
