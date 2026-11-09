import { afterEach, expect, test, vi } from 'vitest';
import { THEME_IDS } from '@shared/themes';
import { initPlatform, resetPlatformForTests } from '@shared/platform';
import { contrast } from '../contrast';
import { xtermTheme } from './xtermTheme';
import { FIND_LIMIT, continuesQuery, findCount, findNote, onTerminalFind, regexCompiles, requestTerminalFind, selectionQuery, terminalFindColors, terminalFindKeys } from './find';

afterEach(() => { resetPlatformForTests(); });

test('the addon’s results as the card’s counter: index and total, "1,000+" once the limit is reached', () => {
  expect(findCount({ resultIndex: 2, resultCount: 17 })).toEqual({ total: 17, capped: false, index: 2 });
  expect(findCount({ resultIndex: -1, resultCount: 0 })).toEqual({ total: 0, capped: false, index: -1 });
  // Past the limit the addon stops counting (and the current match may be past it: no index).
  expect(findCount({ resultIndex: -1, resultCount: FIND_LIMIT })).toEqual({ total: FIND_LIMIT, capped: true, index: -1 });
  expect(findCount({ resultIndex: 4, resultCount: FIND_LIMIT })).toEqual({ total: FIND_LIMIT, capped: true, index: 4 });
});

test('match colors come from the theme, opaque (xterm’s decorations take #RRGGBB), the current one stronger', () => {
  // Aurora: --hit-bg (amber 24%) and --hit-strong (amber 50%) over --term-bg #10101C.
  expect(terminalFindColors('aurora')).toEqual({
    matchBackground: '#483A1E', activeMatchBackground: '#866820',
    matchOverviewRuler: 'rgba(251,191,36,0.85)', activeMatchColorOverviewRuler: '#FBBF24', activeMatchBorder: '#FBBF24'
  });
  for (const id of THEME_IDS) {
    const c = terminalFindColors(id);
    const fg = xtermTheme(id).foreground!;
    expect(c.matchBackground, id).toMatch(/^#[0-9A-F]{6}$/);
    expect(c.activeMatchBackground, id).toMatch(/^#[0-9A-F]{6}$/);
    // Text on a match stays readable.
    expect(contrast(fg, c.matchBackground), id).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, c.activeMatchBackground), id).toBeGreaterThanOrEqual(3);
  }
});

test('the key as each platform shows it: ⌘F, Ctrl+Shift+F on Windows', () => {
  initPlatform('darwin');
  expect(terminalFindKeys()).toBe('⌘F');
  initPlatform('win32');
  expect(terminalFindKeys()).toBe('Ctrl+Shift+F');
});

test('⌘F with a selection: one line up to 100 characters becomes the query, escaped for a regular expression', () => {
  const base = { search: 'old', caseSensitive: true, wholeWord: false, regexp: false, replace: '' };
  expect(selectionQuery('row 7', base)).toEqual({ ...base, search: 'row 7' });
  // The addon takes a plain query literally: backslashes stay as they are.
  expect(selectionQuery('C:\\Users', base)?.search).toBe('C:\\Users');
  expect(selectionQuery('a.b (c)', { ...base, regexp: true })?.search).toBe('a\\.b \\(c\\)');
  expect(selectionQuery('', base)).toBeNull();
  expect(selectionQuery('one\ntwo', base)).toBeNull();
  expect(selectionQuery('x'.repeat(101), base)).toBeNull();
  expect(selectionQuery('x'.repeat(100), base)?.search).toBe('x'.repeat(100));
});

test('a regular expression is checked as the addon compiles it (no u flag): \\- is fine there, an open group is not', () => {
  expect(regexCompiles('a\\-b')).toBe(true);
  expect(regexCompiles('row 1.0')).toBe(true);
  expect(regexCompiles('(')).toBe(false);
  expect(regexCompiles('[a')).toBe(false);
});

test('a query typed on from the last one (grown, shortened, other case) keeps its place; any other starts from the newest', () => {
  expect(continuesQuery('nee', 'needle')).toBe(true);
  expect(continuesQuery('needle', 'need')).toBe(true);
  expect(continuesQuery('needle', 'NEEDLE')).toBe(true);
  expect(continuesQuery('needle', 'needle')).toBe(true);
  expect(continuesQuery('needle', 'row 1')).toBe(false);
  expect(continuesQuery(null, 'needle')).toBe(false);
  expect(continuesQuery('', 'needle')).toBe(false);
});

test('the note under the field: the alternate screen first, else past the limit only the oldest matches are marked', () => {
  expect(findNote({ alt: true, capped: false })).toBe("Full-screen program: only what's on screen is searched.");
  expect(findNote({ alt: true, capped: true })).toBe("Full-screen program: only what's on screen is searched.");
  expect(findNote({ alt: false, capped: true })).toBe('Over 1,000 matches: only the oldest 1,000 are marked.');
  expect(findNote({ alt: false, capped: false })).toBeNull();
});

test('a request to open Find reaches that terminal’s listener only; false when no view listens', () => {
  const a = vi.fn();
  const b = vi.fn();
  const offA = onTerminalFind('a', a);
  onTerminalFind('b', b);
  expect(requestTerminalFind('a')).toBe(true);
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  offA();
  expect(requestTerminalFind('a')).toBe(false);
  expect(requestTerminalFind('nope')).toBe(false);
});
