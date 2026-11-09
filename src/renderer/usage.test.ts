import { expect, test } from 'vitest';
import { ringArc, shortPath, usageTone } from './usage';

test('tone of the limits bar', () => {
  expect(usageTone(0)).toBe('brand');
  expect(usageTone(79)).toBe('brand');
  expect(usageTone(80)).toBe('warn');
  expect(usageTone(94.9)).toBe('warn');
  expect(usageTone(95)).toBe('danger');
  expect(usageTone(Number.NaN)).toBe('brand');
});

test('the usage ring: its arc as a share of the circle, none at 0% (a round cap would draw a dot)', () => {
  expect(ringArc(34)).toBe('34 100');
  expect(ringArc(12.6)).toBe('12.6 100');
  expect(ringArc(100)).toBe('100 100');
  expect(ringArc(130)).toBe('100 100');
  expect(ringArc(0)).toBeNull();
  expect(ringArc(-5)).toBeNull();
  expect(ringArc(Number.NaN)).toBeNull();
});

test('abbreviated path in the top bar', () => {
  expect(shortPath('/Users/me/Documents/repos/shop')).toBe('~/…/repos/shop');
  expect(shortPath('/Users/me/x')).toBe('~/x');
  expect(shortPath('/Users/me/a/b')).toBe('~/a/b');
  expect(shortPath('/opt/a')).toBe('/opt/a');
  expect(shortPath('/opt/a/b/c/d')).toBe('/…/c/d');
});

test('Windows: the drive kept, ~ for the user’s folder, never a leading slash, Windows separators (display only)', () => {
  // The paths are canonical (C:/…) inside the app; what the header and Welcome show reads like File Explorer.
  expect(shortPath('C:/Users/me/Documents/repos/shop', 'win32')).toBe('~\\…\\repos\\shop');
  expect(shortPath('C:/Users/me/x', 'win32')).toBe('~\\x');
  expect(shortPath('C:/dev/p2-proj', 'win32')).toBe('C:\\dev\\p2-proj');
  expect(shortPath('D:/work/a/b/c', 'win32')).toBe('D:\\…\\b\\c');
  expect(shortPath('C:/', 'win32')).toBe('C:\\');
});
