import { beforeAll, expect, test } from 'vitest';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { atelierTheme, DEFAULT_FG } from '../theme';
import gosu from './gosu';

const KEYWORD = 'var(--syn-keyword)';
const OPERATOR = 'var(--syn-operator)';
const STRING = 'var(--syn-string)';
const NUMBER = 'var(--syn-number)';
const TYPE = 'var(--syn-type)';
const FUNCTION = 'var(--syn-function)';
const COMMENT = 'var(--syn-comment)';

let h: HighlighterCore;
beforeAll(async () => {
  // Same engine as the worker: the grammar's regexes must work without Oniguruma.
  h = await createHighlighterCore({ themes: [atelierTheme], langs: [gosu], engine: createJavaScriptRegexEngine({ forgiving: false }) });
});

/** The color of the first token whose text is `text` on the line that contains `line`. */
function colorOf(code: string, line: string, text: string): string {
  const tokens = h.codeToTokens(code, { lang: 'gosu', theme: 'atelier' }).tokens;
  const row = tokens[code.split('\n').findIndex((l) => l.includes(line))]!;
  const t = row.find((x) => x.content.trim() === text);
  if (!t) throw new Error(`no token "${text}" in ${JSON.stringify(row.map((x) => x.content))}`);
  return t.color ?? DEFAULT_FG;
}

const CLASS = `package acme.claims

uses gw.api.util.DateUtil
uses java.util.*

/**
 * A claim helper.
 */
@Export
class ClaimHelper extends AbstractHelper implements IHelper {
  private var _count : int = 42
  static final var LIMIT = 1.5d

  construct(c : Claim) {
    _count = 0x1F
  }

  property get Count() : int {
    return _count // the count
  }

  function describe(claim : Claim) : String {
    if (claim typeis Contact and not claim.Closed) {
      var name = claim as Contact
    }
    for (e in claim.Exposures index i) {
      print("Exposure \${e.DisplayName} #\${i}")
    }
    var ok = claim.Exposures.where(\\ e -> e.Amount > 100).HasElements
    return 'ok' + null + true
  }
}
`;

test('declarations: package/uses, class header, modifiers, construct, property, function', () => {
  expect(colorOf(CLASS, 'package acme', 'package')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'uses gw.api', 'uses')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'class ClaimHelper', 'class')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'class ClaimHelper', 'ClaimHelper')).toBe(TYPE);
  expect(colorOf(CLASS, 'class ClaimHelper', 'extends')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'class ClaimHelper', 'AbstractHelper')).toBe(TYPE);
  expect(colorOf(CLASS, 'private var _count', 'private')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'private var _count', 'var')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'private var _count', 'int')).toBe(TYPE);
  expect(colorOf(CLASS, 'construct(', 'construct')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'property get', 'property')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'property get', 'get')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'property get', 'Count')).toBe(FUNCTION);
  expect(colorOf(CLASS, 'function describe', 'function')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'function describe', 'describe')).toBe(FUNCTION);
  expect(colorOf(CLASS, 'function describe', 'String')).toBe(TYPE);
  expect(colorOf(CLASS, '@Export', '@Export')).not.toBe(DEFAULT_FG);
});

test('statements: Gosu operators, literals, comments, string templates, blocks', () => {
  expect(colorOf(CLASS, 'typeis', 'typeis')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'typeis', 'and')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'typeis', 'not')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'claim as Contact', 'as')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'index i', 'in')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'index i', 'index')).toBe(KEYWORD);
  expect(colorOf(CLASS, 'LIMIT = 1.5d', '1.5d')).toBe(NUMBER);
  expect(colorOf(CLASS, '0x1F', '0x1F')).toBe(NUMBER);
  expect(colorOf(CLASS, 'return _count', '// the count')).toBe(COMMENT);
  expect(colorOf(CLASS, 'A claim helper', '* A claim helper.')).toBe(COMMENT);
  expect(colorOf(CLASS, 'print(', '"Exposure')).toBe(STRING);
  // ${...} inside a string is code again.
  expect(colorOf(CLASS, 'print(', 'e')).toBe(DEFAULT_FG);
  expect(colorOf(CLASS, 'where(', '->')).toBe(OPERATOR);
  // Collection methods with keyword-like names are calls.
  expect(colorOf(CLASS, 'where(', 'where')).toBe(FUNCTION);
  expect(colorOf(CLASS, "return 'ok'", "'ok'")).toBe(STRING);
  expect(colorOf(CLASS, "return 'ok'", 'null')).toBe(KEYWORD);
  expect(colorOf(CLASS, "return 'ok'", 'true')).toBe(KEYWORD);
});

test('contextual words stay names outside their construct; a ternary value is not a type', () => {
  const code = 'var index = map.get(key)\nvar x = big ? small : other\n';
  expect(colorOf(code, 'var index', 'index')).toBe(DEFAULT_FG);
  expect(colorOf(code, 'var index', 'get')).toBe(FUNCTION);
  expect(colorOf(code, 'big ?', 'other')).toBe(DEFAULT_FG);
});

test('enhancements', () => {
  const enh = 'enhancement ClaimEnhancement : entity.Claim {\n  function isBig() : boolean { return this.Amount > 1000 }\n}\n';
  expect(colorOf(enh, 'enhancement', 'enhancement')).toBe(KEYWORD);
  expect(colorOf(enh, 'enhancement', 'ClaimEnhancement')).toBe(TYPE);
  expect(colorOf(enh, 'isBig', 'boolean')).toBe(TYPE);
  expect(colorOf(enh, 'isBig', 'this')).toBe(KEYWORD);
});
