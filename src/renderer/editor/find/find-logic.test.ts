import { EditorSelection, EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { expect, test } from 'vitest';
import { counterText, countMatches, initialQuery, matchList, regexError, selectAllMatches, shortcutAction, swapEnter, tickPositions } from './find-logic';

const DOC = [
  "import type { Session, SessionState } from '../shared/sessions';",
  'export function sortSessions(list: Session[]): Session[] {',
  '  return list; // session order'
].join('\n');

const at = (doc: string, from: number, to = from) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });
const q = (search: string, o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regexp: boolean }> = {}) => new SearchQuery({ search, ...o });

test('counts the matches of the query, with case, whole word and regular expression', () => {
  const s = at(DOC, 0);
  expect(countMatches(s, q('session')).total).toBe(7);
  expect(countMatches(s, q('session', { caseSensitive: true })).total).toBe(2);
  expect(countMatches(s, q('Session', { wholeWord: true })).total).toBe(4);
  expect(countMatches(s, q('Session', { wholeWord: true, caseSensitive: true })).total).toBe(3);
  expect(countMatches(s, q('Session(State|s)', { regexp: true })).total).toBe(3);
  expect(countMatches(s, q('')).total).toBe(0);
  expect(countMatches(s, q('sess(ion', { regexp: true }))).toEqual({ total: 0, capped: false, index: -1 });
});

test('the index is the main selection among the matches, -1 when the selection is not a match', () => {
  const second = DOC.indexOf('SessionState');
  expect(countMatches(at(DOC, second, second + 7), q('session')).index).toBe(1);
  expect(countMatches(at(DOC, second, second + 6), q('session')).index).toBe(-1);
  expect(countMatches(at(DOC, 0), q('session')).index).toBe(-1);
});

test('counting stops at the cap', () => {
  const many = 'ab '.repeat(50);
  expect(countMatches(at(many, 0), q('ab'), 20)).toEqual({ total: 20, capped: true, index: -1 });
  expect(countMatches(at(many, 0), q('ab'), 50)).toEqual({ total: 50, capped: false, index: -1 });
});

test('counter: position, total, capped, no results, invalid, quiet after replace all, narrow forms', () => {
  const base = { empty: false, valid: true, total: 14, capped: false, index: 2, quiet: false };
  expect(counterText(base, false)).toEqual({ text: '3 of 14', tone: 'normal' });
  expect(counterText(base, true)).toEqual({ text: '3/14', tone: 'normal' });
  expect(counterText({ ...base, index: -1 }, false)).toEqual({ text: '14 results', tone: 'normal' });
  expect(counterText({ ...base, index: -1, total: 1 }, false)).toEqual({ text: '1 result', tone: 'normal' });
  expect(counterText({ ...base, index: -1 }, true)).toEqual({ text: '14', tone: 'normal' });
  expect(counterText({ ...base, index: -1, total: 9999, capped: true }, false)).toEqual({ text: '9,999+ results', tone: 'normal' });
  expect(counterText({ ...base, index: 0, total: 9999, capped: true }, false)).toEqual({ text: '1 of 9,999+', tone: 'normal' });
  expect(counterText({ ...base, total: 0, index: -1 }, false)).toEqual({ text: 'No results', tone: 'error' });
  expect(counterText({ ...base, total: 0, index: -1 }, true)).toEqual({ text: 'None', tone: 'error' });
  expect(counterText({ ...base, total: 0, index: -1, quiet: true }, false)).toEqual({ text: 'No results', tone: 'quiet' });
  expect(counterText({ ...base, valid: false, total: 0, index: -1 }, false)).toEqual({ text: 'Invalid', tone: 'error' });
  expect(counterText({ ...base, empty: true, total: 0, index: -1 }, false)).toEqual({ text: '', tone: 'normal' });
});

test('regular expression errors in plain words', () => {
  expect(regexError('sess(ion')).toBe('Unclosed group: add ) or escape the (');
  expect(regexError('session)')).toBe('Unmatched ): add a ( or escape it');
  expect(regexError('*session')).toBe('Nothing to repeat: escape the *, + or ?');
  expect(regexError('[abc')).toBe('Unclosed [ ]: add ] or escape the [');
  expect(regexError('abc\\')).toBe('A \\ at the end: escape it as \\\\');
  // Any other engine message, without its "Invalid regular expression: /…/flags:" prefix.
  expect(regexError('a{2,1}')).toBe('numbers out of order in {} quantifier');
  expect(regexError('sess(ion)')).toBeNull();
  expect(regexError('')).toBeNull();
});

test('scrollbar ticks: one per line position, close ones merged, the selected one kept, capped', () => {
  const ticks = tickPositions([{ top: 0, selected: false }, { top: 10, selected: true }, { top: 500, selected: false }, { top: 990, selected: false }], 1000, 200);
  expect(ticks).toEqual([{ y: 0, selected: true }, { y: 100, selected: false }, { y: 198, selected: false }]);
  expect(tickPositions([], 1000, 200)).toEqual([]);
  expect(tickPositions([{ top: 0, selected: false }], 0, 200)).toEqual([]);
  const many = Array.from({ length: 100 }, (_, i) => ({ top: i * 100, selected: i === 97 }));
  const capped = tickPositions(many, 10_000, 1000, 10);
  expect(capped.length).toBeLessThanOrEqual(10);
  expect(capped.some((t) => t.selected)).toBe(true);
});

const key = (k: Partial<KeyboardEvent>) => ({ key: '', code: '', altKey: false, metaKey: false, shiftKey: false, ctrlKey: false, isComposing: false, ...k });

test('keys in the card: Enter moves or replaces, ⌥ toggles options by key code, Esc closes', () => {
  expect(shortcutAction(key({ key: 'Enter' }), 'find', false)).toBe('next');
  expect(shortcutAction(key({ key: 'Enter', shiftKey: true }), 'find', false)).toBe('prev');
  expect(shortcutAction(key({ key: 'Enter', altKey: true }), 'find', false)).toBe('selectAll');
  expect(shortcutAction(key({ key: 'Enter' }), 'replace', false)).toBe('replace');
  expect(shortcutAction(key({ key: 'Enter', metaKey: true }), 'replace', false)).toBe('replaceAll');
  expect(shortcutAction(key({ key: 'Enter', metaKey: true }), 'find', false)).toBeNull();
  expect(shortcutAction(key({ key: 'Enter' }), 'replace', true)).toBeNull();
  // ⌥C types "ç" or "©" depending on the layout: the physical key decides.
  expect(shortcutAction(key({ key: 'ç', code: 'KeyC', altKey: true }), 'find', false)).toBe('toggleCase');
  expect(shortcutAction(key({ key: 'Ω', code: 'KeyW', altKey: true }), 'replace', false)).toBe('toggleWord');
  expect(shortcutAction(key({ key: '®', code: 'KeyR', altKey: true }), 'other', true)).toBe('toggleRegex');
  expect(shortcutAction(key({ code: 'KeyC', altKey: true, metaKey: true }), 'find', false)).toBeNull();
  expect(shortcutAction(key({ key: 'Escape' }), 'other', false)).toBe('close');
  expect(shortcutAction(key({ key: 'a' }), 'find', false)).toBeNull();
});

test('the query a new card starts from: a short one-line selection, else the last one', () => {
  const last = { search: 'focus', caseSensitive: true, wholeWord: false, regexp: false, replace: 'blur' };
  const sel = DOC.indexOf('sortSessions');
  expect(initialQuery(at(DOC, sel, sel + 12), last)).toEqual({ ...last, search: 'sortSessions' });
  expect(initialQuery(at(DOC, sel), last)).toEqual(last);
  expect(initialQuery(at(DOC, 0, DOC.indexOf('export') + 3), last)).toEqual(last);
  expect(initialQuery(at('x'.repeat(200), 0, 150), last)).toEqual(last);
  expect(initialQuery(at(DOC, sel, sel + 4), null)).toEqual({ search: 'sort', caseSensitive: false, wholeWord: false, regexp: false, replace: '' });
  expect(initialQuery(at(DOC, 0), null)).toEqual({ search: '', caseSensitive: false, wholeWord: false, regexp: false, replace: '' });
  // A selection searched with regular expressions on is escaped, so it still finds itself.
  const dot = 'a.b(c)';
  expect(initialQuery(at(dot, 0, 6), { ...last, regexp: true }).search).toBe('a\\.b\\(c\\)');
  // Without regular expressions a backslash is still an escape (\n, \t): doubled, a selected "\n" finds itself.
  const src = 'const nl = "\\n";';
  const seeded = initialQuery(at(src, src.indexOf('\\'), src.indexOf('\\') + 2), null);
  expect(seeded.search).toBe('\\\\n');
  expect(countMatches(at(src, 0), new SearchQuery(seeded)).total).toBe(1);
});

test('the match list is computed once per document and query; moving the selection only looks the index up', () => {
  const s = at(DOC, 0);
  const query = q('session');
  const a = matchList(s, query);
  expect(a.ranges).toHaveLength(7);
  const second = DOC.indexOf('SessionState');
  const moved = s.update({ selection: { anchor: second, head: second + 7 } }).state;
  expect(matchList(moved, q('session'))).toBe(a);
  expect(countMatches(moved, q('session')).index).toBe(1);
  const edited = s.update({ changes: { from: 0, insert: 'session ' } }).state;
  expect(matchList(edited, query)).not.toBe(a);
  expect(matchList(edited, query).ranges).toHaveLength(8);
  expect(matchList(s, q('session', { caseSensitive: true }))).not.toBe(a);
});

test('select all matches: every match a cursor past CodeMirror\'s 1000, nothing (and a reason) past the cap', () => {
  const doc = 'ab '.repeat(1500);
  const sel = selectAllMatches(at(doc, 0), q('ab'));
  if (!sel || sel === 'too-many') throw new Error(`expected a selection, got ${sel}`);
  expect(sel.ranges).toHaveLength(1500);
  expect([sel.ranges[1]!.from, sel.ranges[1]!.to]).toEqual([3, 5]);
  expect(selectAllMatches(at(doc, 0), q('ab'), 1000)).toBe('too-many');
  expect(selectAllMatches(at(doc, 0), q('zz'))).toBeNull();
  expect(selectAllMatches(at(doc, 0), q('a(', { regexp: true }))).toBeNull();
});

test('keys during an IME composition belong to the input method', () => {
  expect(shortcutAction(key({ key: 'Enter', isComposing: true }), 'find', false)).toBeNull();
  expect(shortcutAction(key({ key: 'Escape', isComposing: true }), 'find', false)).toBeNull();
});

test('a terminal’s card: ↵ goes up to older output, ⇧↵ down; other cards keep ↵ = next', () => {
  expect(swapEnter('next', true)).toBe('prev');
  expect(swapEnter('prev', true)).toBe('next');
  expect(swapEnter('close', true)).toBe('close');
  expect(swapEnter('toggleCase', true)).toBe('toggleCase');
  expect(swapEnter('next', false)).toBe('next');
  expect(swapEnter('prev', false)).toBe('prev');
});
