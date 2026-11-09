import { describe, expect, test } from 'vitest';
import { MemoryStorage, installStorageShim } from './storage';

// The demo is same-origin with the site: the app's localStorage keys must never reach the
// visitor's browser, and each visit starts fresh.

describe('MemoryStorage', () => {
  test('behaves like Storage: strings in, strings out, null when absent', () => {
    const s = new MemoryStorage();
    expect(s.getItem('a')).toBeNull();
    s.setItem('a', 'x');
    s.setItem('n', 42 as unknown as string);
    expect(s.getItem('a')).toBe('x');
    expect(s.getItem('n')).toBe('42');
    expect(s.length).toBe(2);
    expect(s.key(0)).toBe('a');
    expect(s.key(5)).toBeNull();
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
    s.clear();
    expect(s.length).toBe(0);
  });

  test('two instances share nothing', () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    a.setItem('k', 'v');
    expect(b.getItem('k')).toBeNull();
  });
});

describe('installStorageShim', () => {
  test("replaces the window's localStorage and sessionStorage with fresh in-memory ones", () => {
    const real = { setItem: () => { throw new Error('the real storage was written'); } };
    const win = { localStorage: real, sessionStorage: real } as unknown as Window;
    installStorageShim(win);
    expect(win.localStorage).toBeInstanceOf(MemoryStorage);
    expect(win.sessionStorage).toBeInstanceOf(MemoryStorage);
    expect(win.localStorage).not.toBe(win.sessionStorage);
    win.localStorage.setItem('atelier.panels', '{}');
    expect(win.localStorage.getItem('atelier.panels')).toBe('{}');
    expect(win.sessionStorage.getItem('atelier.panels')).toBeNull();
  });

  test('works where the real accessor is a getter (a browser window)', () => {
    const win = {} as Window;
    Object.defineProperty(win, 'localStorage', { get: () => { throw new Error('denied'); }, configurable: true });
    Object.defineProperty(win, 'sessionStorage', { get: () => { throw new Error('denied'); }, configurable: true });
    installStorageShim(win);
    win.localStorage.setItem('x', '1');
    expect(win.localStorage.getItem('x')).toBe('1');
  });
});
