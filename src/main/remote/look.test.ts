import { describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings';
import { resolveToken } from '@shared/theme-resolve';
import { THEMES } from '@shared/themes';
import { THEME_BLOCKS } from '../theme-chrome';
import { LOOK_SETTINGS, LOOK_TOKENS, lookKey, remoteLook } from './look';

const look = (o: Partial<Settings> = {}) => remoteLook({ ...DEFAULT_SETTINGS, ...o }, THEME_BLOCKS);

describe('the themes a phone gets', () => {
  test('every theme Atelier has, in Settings\' order, as THEMES describes it', () => {
    expect(look().themes.map(({ id, name, appearance, dark }) => ({ id, name, appearance, dark }))).toEqual(THEMES.map(({ id, name, appearance, dark }) => ({ id, name, appearance, dark })));
  });

  test('a light theme names the dark theme its terminals borrow; a dark theme names itself', () => {
    const by = new Map(look().themes.map((t) => [t.id, t]));
    expect(by.get('daylight')).toMatchObject({ appearance: 'light', dark: 'aurora' });
    expect(by.get('paper')).toMatchObject({ appearance: 'light', dark: 'ink' });
    expect(by.get('ember')).toMatchObject({ appearance: 'dark', dark: 'ember' });
  });

  test('the tokens, interface then terminal, in this order', () => {
    const n = (p: string) => Array.from({ length: p === 'ansi' ? 16 : 8 }, (_, i) => `${p}-${p === 'ansi' ? i : i + 1}`);
    expect(LOOK_TOKENS).toEqual([
      'bg-0', 'bg-1', 'bg-2', 'bg-3', 'bg-float', 'line', 'line-soft', 'line-strong', 'text', 'text-2', 'text-3', 'text-4', 'text-error', 'link',
      'violet', 'violet-soft', 'violet-light', 'pink', 'on-brand', 'waiting', 'working', 'done', 'error', ...n('ws'), ...n('person'),
      'worktree', 'worktree-text', 'abyss', 'term-bg', 'term-fg', 'term-cursor', 'term-sel', ...n('ansi')
    ]);
  });

  test('every theme has every token, as finished hex colors only (no rgba, no var)', () => {
    for (const t of look().themes) {
      expect(Object.keys(t.colors), t.id).toEqual([...LOOK_TOKENS]);
      for (const [token, c] of Object.entries(t.colors)) expect(c, `${t.id} ${token}`).toMatch(/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/);
    }
  });

  test('the colors are the theme\'s own: opaque ones as resolved, translucent ones with their alpha byte', () => {
    const by = new Map(look().themes.map((t) => [t.id, t.colors]));
    for (const t of THEMES) {
      for (const token of LOOK_TOKENS) {
        const css = resolveToken(THEME_BLOCKS, t.id, `--${token}`);
        if (css.startsWith('#')) expect(by.get(t.id)![token], `${t.id} ${token}`).toBe(css);
      }
    }
    // Aurora's floating surfaces: rgba(18,18,32,.86), 0.86 × 255 → DB.
    expect(by.get('aurora')!['bg-float']).toBe('#121220DB');
    // Each theme's terminals are its own: Daylight's are light, not Aurora's.
    expect(by.get('daylight')!['term-bg']).not.toBe(by.get('aurora')!['term-bg']);
  });

  test('resolved once: the same themes every time', () => {
    expect(look({ theme: 'ember' }).themes).toBe(look({ theme: 'tide' }).themes);
  });
});

describe('the theme in use and the terminal', () => {
  test('from Settings › Appearance and Terminal', () => {
    const l = look({ theme: 'paper', terminalColors: 'dark', terminalFontFamily: 'SF Mono', terminalFontSize: 15, terminalLineHeight: 1.35, cursorStyle: 'underline', cursorBlink: false });
    expect(l).toMatchObject({ theme: 'paper', terminalColors: 'dark', terminal: { font: 'SF Mono', size: 15, lineHeight: 1.35, cursor: 'underline', blink: false } });
    expect(Object.keys(l)).toEqual(['theme', 'terminalColors', 'terminal', 'themes']);
  });

  test('the defaults: Aurora, terminals following the theme, Atelier\'s own font', () => {
    expect(look()).toMatchObject({ theme: 'aurora', terminalColors: 'theme', terminal: { font: 'JetBrains Mono', size: 13, lineHeight: 1.2, cursor: 'bar', blink: true } });
  });

  test('a theme id Atelier no longer has is Aurora, one of the themes sent', () => {
    expect(look({ theme: 'gone' as Settings['theme'] }).theme).toBe('aurora');
  });

  test('the key changes with each setting the look reads, and with nothing else', () => {
    const base = lookKey(look());
    const changed: Partial<Settings> = { theme: 'tide', terminalColors: 'dark', terminalFontFamily: 'Menlo', terminalFontSize: 18, terminalLineHeight: 1.5, cursorStyle: 'block', cursorBlink: false };
    expect(Object.keys(changed).sort()).toEqual([...LOOK_SETTINGS].sort());
    for (const k of LOOK_SETTINGS) expect(lookKey(look({ [k]: changed[k] })), k).not.toBe(base);
    expect(lookKey(look({ remoteRelay: 'wss://relay.invalid', projectTint: !DEFAULT_SETTINGS.projectTint, interfaceSize: 'large' }))).toBe(base);
  });
});
