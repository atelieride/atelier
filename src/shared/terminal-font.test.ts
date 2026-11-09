import { expect, test } from 'vitest';
import { BUNDLED_FONT, fontMissing, fontStack, installedMonospace, isFontFamily, isMonospaced, MONO_PROBE } from './terminal-font';

test('isFontFamily: a plain family name, nothing that could break out of its quotes', () => {
  for (const ok of ['JetBrains Mono', 'Menlo', 'MesloLGS NF', 'Fira Code', 'IBM Plex Mono', 'Font-Name_2.0 (Beta) & Co', 'Hiragino 角ゴ', 'x'.repeat(100)]) {
    expect(isFontFamily(ok), ok).toBe(true);
  }
  for (const bad of ['', ' ', ' Menlo', 'Menlo ', 'a"b', 'a\\b', 'a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'x'.repeat(101), 42, null, undefined, ['Menlo']]) {
    expect(isFontFamily(bad), JSON.stringify(bad)).toBe(false);
  }
});

test('fontStack: the chosen family first, then Atelier\'s own, then the system\'s', () => {
  expect(BUNDLED_FONT).toBe('JetBrains Mono');
  expect(fontStack('JetBrains Mono')).toBe("'JetBrains Mono', ui-monospace, Menlo, monospace");
  expect(fontStack('Fira Code')).toBe("\"Fira Code\", 'JetBrains Mono', ui-monospace, Menlo, monospace");
  // A value that isn't a family name (prefs edited by hand, never through validation) draws as the default.
  expect(fontStack('a"b')).toBe(fontStack('JetBrains Mono'));
});

test('isMonospaced: every probe glyph as wide as the first', () => {
  expect(MONO_PROBE).toEqual(['i', 'W', 'm', '.', '0', 'l']);
  expect(isMonospaced(() => 24)).toBe(true);
  expect(isMonospaced((ch) => (ch === 'W' ? 24.03 : 24))).toBe(true);
  expect(isMonospaced((ch) => (ch === 'i' ? 8.9 : 24))).toBe(false);
  expect(isMonospaced(() => 0)).toBe(false);
});

test('installedMonospace: monospaced families, without hidden faces, duplicates or the bundled font, sorted', () => {
  const mono = new Set(['Menlo', 'monaco', 'Courier New', 'JetBrains Mono', '.SF NS Mono', 'Andale Mono']);
  const families = ['Menlo', 'Helvetica', 'monaco', 'Courier New', 'Menlo', 'JetBrains Mono', '.SF NS Mono', 'Andale Mono', 'Arial'];
  expect(installedMonospace(families, (f) => mono.has(f))).toEqual(['Andale Mono', 'Courier New', 'Menlo', 'monaco']);
  expect(installedMonospace([], () => true)).toEqual([]);
  // A name that couldn't be saved is never offered.
  expect(installedMonospace(['Bad"Name', 'Ok Mono'], () => true)).toEqual(['Ok Mono']);
});

test('fontMissing: only a non-bundled font absent from a list that was read', () => {
  expect(fontMissing('Berkeley Mono', ['Menlo'])).toBe(true);
  expect(fontMissing('Menlo', ['Menlo'])).toBe(false);
  expect(fontMissing('JetBrains Mono', [])).toBe(false);
  expect(fontMissing('Berkeley Mono', null)).toBe(false);
});
