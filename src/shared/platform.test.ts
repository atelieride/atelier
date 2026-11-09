import { afterEach, describe, expect, test } from 'vitest';
import { asPlatform, currentPlatform, initPlatform, pathStyle, resetPlatformForTests, setTestDefaultPlatform } from './platform';

const g = globalThis as { atelier?: { platform?: unknown } };

afterEach(() => { resetPlatformForTests(); delete g.atelier; });

describe('platform', () => {
  test('anything but win32 and linux reads as darwin', () => {
    expect(asPlatform('win32')).toBe('win32');
    expect(asPlatform('linux')).toBe('linux');
    expect(asPlatform('darwin')).toBe('darwin');
    expect(asPlatform('freebsd')).toBe('darwin');
    expect(asPlatform(undefined)).toBe('darwin');
    expect(asPlatform(42)).toBe('darwin');
  });

  test('without a forced value: the preload’s window.atelier.platform, else Node’s process.platform', () => {
    setTestDefaultPlatform(null);
    try {
      expect(currentPlatform()).toBe(asPlatform(process.platform));
      g.atelier = { platform: 'win32' };
      expect(currentPlatform()).toBe('win32');
    } finally { setTestDefaultPlatform('darwin'); }
  });

  test("a forced platform wins until reset, which goes back to the tests' default (darwin, set by the unit setup)", () => {
    initPlatform('win32');
    g.atelier = { platform: 'darwin' };
    expect(currentPlatform()).toBe('win32');
    resetPlatformForTests();
    expect(currentPlatform()).toBe('darwin');
  });

  test('path style follows the platform', () => {
    expect(pathStyle('darwin')).toBe('posix');
    expect(pathStyle('linux')).toBe('posix');
    expect(pathStyle('win32')).toBe('win32');
    initPlatform('win32');
    expect(pathStyle()).toBe('win32');
  });
});
