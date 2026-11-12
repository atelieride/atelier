import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { compileSearch, lineResult } from './search-match';
import type { SearchSpec } from './search';

function spec(query: string, o: Partial<Omit<SearchSpec, 'query'>> = {}): SearchSpec {
  return { query, matchCase: false, wholeWord: false, regex: false, ...o };
}

/** What the editor's find card finds, by line: the matches of the same `SearchQuery` the card builds. */
function editorMatches(s: SearchSpec, text: string): [number, number][][] {
  const q = new SearchQuery({ search: s.query, caseSensitive: s.matchCase, wholeWord: s.wholeWord, regexp: s.regex });
  const state = EditorState.create({ doc: text });
  const out: [number, number][][] = Array.from({ length: state.doc.lines }, () => []);
  const cursor = q.getCursor(state);
  for (let n = cursor.next(); !n.done; n = cursor.next()) {
    const line = state.doc.lineAt(n.value.from);
    if (n.value.to > n.value.from) out[line.number - 1]!.push([n.value.from - line.from, n.value.to - line.from]);
  }
  return out;
}

function ours(s: SearchSpec, text: string): [number, number][][] {
  const c = compileSearch(s);
  if (c.kind !== 'ok') throw new Error(`not ok: ${c.kind}`);
  return text.split('\n').map((l) => c.ranges(l));
}

const samples: { name: string; s: SearchSpec; text: string }[] = [
  { name: 'plain', s: spec('token'), text: 'TokenStore token tokens _token token.' },
  { name: 'match case on', s: spec('token', { matchCase: true }), text: 'TokenStore token tokens _token Token' },
  { name: 'match case off', s: spec('Token'), text: 'TokenStore token tokens _token Token' },
  { name: 'tab escape', s: spec('a\\tb'), text: 'a\tb a b a\\tb' },
  { name: 'backslash escape', s: spec('a\\\\b'), text: 'a\\b a/b a\\\\b' },
  { name: 'dotted İ, case off', s: spec('i'), text: 'İstanbul İİ iİi' },
  { name: 'İ query', s: spec('İ'), text: 'İstanbul i̇ İİ' },
  { name: 'ß, case off', s: spec('ss'), text: 'Straße STRASSE strasse' },
  { name: 'ß query', s: spec('ß'), text: 'Straße STRASSE ß' },
  { name: 'compatibility forms', s: spec('fi'), text: 'ﬁnd fi ﬃ' },
  { name: 'emoji before the match', s: spec('token'), text: '🙂 token 🙂token' },
  { name: 'whole word token', s: spec('token', { wholeWord: true }), text: 'TokenStore token tokens _token token. Token' },
  { name: 'whole word Token, case on', s: spec('Token', { wholeWord: true, matchCase: true }), text: 'Token token Tokens xToken' },
  { name: 'whole word tok', s: spec('tok', { wholeWord: true }), text: 'tok token tok_ tok.' },
  { name: 'whole word, non-ASCII neighbours', s: spec('café', { wholeWord: true }), text: 'café cafés éafé café.' },
  { name: 'whole word after emoji', s: spec('a', { wholeWord: true }), text: '🙂a a🙂 🙂a🙂 ab' },
  { name: 'regex optional group', s: spec('tok(en)?s?', { regex: true }), text: 'tok token tokens Tokens' },
  { name: 'regex word boundary', s: spec('\\bstore\\.(get|set)\\b', { regex: true }), text: 'store.get store.set restore.get store.getter' },
  { name: 'regex classes, case off', s: spec('[A-Z]\\w+', { regex: true }), text: 'Hello world fooBar' },
  { name: 'regex case on', s: spec('[A-Z]\\w+', { regex: true, matchCase: true }), text: 'Hello world fooBar' },
  { name: 'regex whole word', s: spec('tok\\w*', { regex: true, wholeWord: true }), text: 'tok token xtok' },
  { name: 'regex unicode', s: spec('\\u{1F642}', { regex: true }), text: 'a 🙂 b' },
  { name: 'several lines', s: spec('x'), text: 'x\nax\n\nxx' },
];

describe('parity with the editor find', () => {
  for (const { name, s, text } of samples) {
    it(name, () => {
      expect(ours(s, text)).toEqual(editorMatches(s, text));
    });
  }
});

describe('compileSearch', () => {
  it('zero-length matches are not results', () => {
    for (const q of ['^', '\\b', 'x*']) {
      const c = compileSearch(spec(q, { regex: true }));
      expect(c.kind).toBe('ok');
      if (c.kind === 'ok') expect(c.ranges('abc')).toEqual([]);
    }
  });

  it('keeps the real matches next to zero-length ones', () => {
    const c = compileSearch(spec('x*', { regex: true }));
    if (c.kind !== 'ok') throw new Error('not ok');
    expect(c.ranges('axxb')).toEqual([[1, 3]]);
  });

  it('a query holding a line break is multiline', () => {
    expect(compileSearch(spec('a\\nb'))).toEqual({ kind: 'multiline' });
    expect(compileSearch(spec('a\\rb'))).toEqual({ kind: 'multiline' });
    expect(compileSearch(spec('a\\nb', { regex: true }))).toEqual({ kind: 'multiline' });
    expect(compileSearch(spec('a\nb', { regex: true }))).toEqual({ kind: 'multiline' });
  });

  it('an escaped backslash before n is not a line break', () => {
    expect(compileSearch(spec('a\\\\nb', { regex: true })).kind).toBe('ok');
    expect(compileSearch(spec('a\\\\nb')).kind).toBe('ok');
  });

  it('an invalid regex is invalid, an empty query is empty', () => {
    expect(compileSearch(spec('readSession(token', { regex: true }))).toEqual({ kind: 'invalid' });
    expect(compileSearch(spec(''))).toEqual({ kind: 'empty' });
    expect(compileSearch(spec('', { regex: true }))).toEqual({ kind: 'empty' });
  });

  it('is reusable across lines', () => {
    const c = compileSearch(spec('a', { regex: true }));
    if (c.kind !== 'ok') throw new Error('not ok');
    expect(c.ranges('aa')).toEqual([[0, 1], [1, 2]]);
    expect(c.ranges('ba')).toEqual([[1, 2]]);
  });
});

describe('lineResult', () => {
  it('keeps the whole line up to the cap when matches are far apart', () => {
    const text = 'x'.repeat(5000);
    const r = lineResult(7, text, [[10, 14], [4900, 4904]], 2000);
    expect(r.line).toBe(7);
    expect(r.start).toBe(0);
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.text).toBe(text.slice(0, r.text.length));
    expect(r.ranges).toEqual([[10, 14], [4900, 4904]]);
  });

  it('keeps 40 characters around a single match', () => {
    const text = 'y'.repeat(6000);
    const r = lineResult(1, text, [[3000, 3005]], 2000);
    expect(r.start).toBe(2960);
    expect(r.text).toBe(text.slice(2960, 3045));
    expect(r.ranges).toEqual([[3000, 3005]]);
  });

  it('keeps a short line whole', () => {
    expect(lineResult(3, 'a token b', [[2, 7]], 2000)).toEqual({ line: 3, text: 'a token b', start: 0, ranges: [[2, 7]] });
  });
});
