import { expect, test } from 'vitest';
import { parseThemeCss, resolveToken } from './theme-resolve';

const css = `
:root {
  --violet: #8B5CF6; --pink: #EC4899; --bg: #10101C; --short: #fff;
  --tint: color-mix(in srgb, var(--violet) 35%, transparent);
  --half: color-mix(in srgb, var(--tint) 50%, transparent);
  --blend: color-mix(in srgb, var(--violet) 50%, var(--pink));
  --alias: var(--bg); --fallback: var(--missing, #000000);
  --raw: rgba(16,16,28,.86);
  --brand: linear-gradient(135deg, var(--violet), var(--pink));
}
:root[data-theme="paper"] { --bg: #FFFFFF; --violet: #161617; }
.other { --bg: #123456; }
`;

test('blocks: :root and each :root[data-theme]; other rules are not tokens', () => {
  const b = parseThemeCss(css);
  expect(Object.keys(b).sort()).toEqual(['', 'paper']);
  expect(b['']!['--bg']).toBe('#10101C');
  expect(b['paper']!['--bg']).toBe('#FFFFFF');
});

test('resolves hex, var, fallbacks, rgba and color-mix to #RRGGBB or rgba()', () => {
  const b = parseThemeCss(css);
  expect(resolveToken(b, 'aurora', '--short')).toBe('#FFFFFF');
  expect(resolveToken(b, 'aurora', '--alias')).toBe('#10101C');
  expect(resolveToken(b, 'aurora', '--fallback')).toBe('#000000');
  expect(resolveToken(b, 'aurora', '--tint')).toBe('rgba(139,92,246,0.35)');
  expect(resolveToken(b, 'aurora', '--half')).toBe('rgba(139,92,246,0.175)');
  expect(resolveToken(b, 'aurora', '--blend')).toBe('#BC52C8');
  expect(resolveToken(b, 'aurora', '--raw')).toBe('rgba(16,16,28,0.86)');
});

test('a theme overrides :root, and what refers to an overridden token follows it', () => {
  const b = parseThemeCss(css);
  expect(resolveToken(b, 'paper', '--alias')).toBe('#FFFFFF');
  expect(resolveToken(b, 'paper', '--tint')).toBe('rgba(22,22,23,0.35)');
  expect(resolveToken(b, 'paper', '--pink')).toBe('#EC4899');
});

test('not a color (a gradient) or an unknown token: an error that names it', () => {
  const b = parseThemeCss(css);
  expect(() => resolveToken(b, 'aurora', '--brand')).toThrow(/--brand/);
  expect(() => resolveToken(b, 'aurora', '--nope')).toThrow(/--nope/);
});

test('a theme block that also matches [data-theme-preview] is read the same', () => {
  const b = parseThemeCss(':root, [data-theme-preview="aurora"] { --bg: #000000; }\n:root[data-theme="paper"], [data-theme-preview="paper"] { --bg: #FFFFFF; }');
  expect(resolveToken(b, 'paper', '--bg')).toBe('#FFFFFF');
  expect(resolveToken(b, 'aurora', '--bg')).toBe('#000000');
});
