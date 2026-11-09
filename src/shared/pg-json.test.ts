import { describe, expect, it } from 'vitest';
import { jsonInString, keyProfile, looksUnixTime, pathLabel, pathLiteral, pathSql, pathText, quoteIdent } from './pg-json';

const hooks = [
  { id: 'e1', created: 1793813327, amount: 5, data: { object: { status: 'paid', lines: [1, 2] }, previous_attributes: { status: 'open' } } },
  { id: 'e2', created: 1793813400, amount: '7', data: { object: { status: 'open', lines: [] } } },
  { id: 'e3', created: 1793813500, amount: 9, data: { object: { status: 'void', lines: null } } },
];

describe('keyProfile', () => {
  const profile = keyProfile(hooks);
  const get = (p: (string | number)[]) => profile.find((s) => s.path.join('\u0000') === p.join('\u0000'));

  it('counts presence per path', () => {
    expect(get(['data', 'object', 'status'])).toMatchObject({ present: 3, kind: 'string' });
    expect(get(['data', 'previous_attributes'])).toMatchObject({ present: 1, kind: 'object' });
  });
  it('detects unix time and mixed kinds', () => {
    expect(get(['created'])?.kind).toBe('unix');
    expect(get(['amount'])?.kind).toBe('mixed');
  });
  it('reports arrays once, without walking them', () => {
    expect(get(['data', 'object', 'lines', 0])).toBeUndefined();
    expect(get(['data', 'object', 'lines'])?.kind).toBe('mixed'); // array, array, null
    expect(keyProfile([{ a: [{ b: 1 }] }])).toEqual([{ path: ['a'], kind: 'array', present: 1 }]);
  });
  it('sorts by presence desc then path text', () => {
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1]!, b = profile[i]!;
      expect(a.present >= b.present).toBe(true);
      if (a.present === b.present) expect(pathText(a.path) <= pathText(b.path)).toBe(true);
    }
  });
  it('caps at max and walks to depth 4 by default', () => {
    expect(keyProfile(hooks, { max: 3 })).toHaveLength(3);
    const deep = keyProfile([{ a: { b: { c: { d: { e: 1 } } } } }]);
    expect(deep.map((s) => s.path.length)).toEqual([1, 2, 3, 4]);
    expect(keyProfile([{ a: { b: 1 } }], { depth: 1 })).toHaveLength(1);
  });
  it('depth 0 walks no level: no paths at all', () => {
    expect(keyProfile(hooks, { depth: 0 })).toEqual([]);
    expect(keyProfile([{ a: 1 }], { depth: -1 })).toEqual([]);
  });
  it('ignores non-object values', () => {
    expect(keyProfile([1, 'x', null, [1], { a: 1 }])).toEqual([{ path: ['a'], kind: 'number', present: 1 }]);
  });
  // The renderer's trees are lossless — a number is an object holding its source text, a secret
  // key's value is masked. `leaf` names their kind first; whatever it names is a leaf, never walked into.
  it('takes a leaf classifier: lossless numbers are numbers (unix time too), masked keys say so, neither is walked', () => {
    class Num { constructor(readonly text: string) {} }
    const leaf = (key: string, v: unknown) => (v instanceof Num ? (looksUnixTime(key, Number(v.text)) ? 'unix' as const : 'number' as const) : key === 'token' ? 'masked' as const : undefined);
    const trees = [
      { created: new Num('1793813327'), id: new Num('12345678901234567890'), token: { a: 1 } },
      { created: new Num('1793813400'), id: new Num('2'), token: 'x' }
    ];
    expect(keyProfile(trees, { leaf })).toEqual([
      { path: ['created'], kind: 'unix', present: 2 },
      { path: ['id'], kind: 'number', present: 2 },
      { path: ['token'], kind: 'masked', present: 2 }
    ]);
  });
});

describe('pathText / pathLabel', () => {
  it('formats paths', () => {
    expect(pathText(['data', 'lines', 0, 'id'])).toBe('data.lines[0].id');
    expect(pathText(['data', 'a.b', 'x y'])).toBe('data["a.b"]["x y"]');
    expect(pathText(['a"b'])).toBe('["a\\"b"]');
    expect(pathText([0, 'x'])).toBe('[0].x');
  });
  it('labels the last element', () => {
    expect(pathLabel(['data', 'status'])).toBe('status');
    expect(pathLabel(['lines', 0])).toBe('[0]');
    expect(pathLabel([])).toBe('');
  });
});

describe('pathSql', () => {
  it('builds the #>> literal', () => {
    expect(pathSql('payload', ['data', 'lines', 0, 'id'])).toBe(`"payload" #>> '{data,lines,0,id}'`);
  });
  it('quotes risky elements', () => {
    expect(pathSql('p', ['a,b'])).toBe(`"p" #>> '{"a,b"}'`);
    expect(pathSql('p', ['a b', 'c}', 'd{', '', 'NULL'])).toBe(`"p" #>> '{"a b","c}","d{","","NULL"}'`);
    expect(pathSql('p', ['q"r', 'b\\s'])).toBe(`"p" #>> '{"q\\"r","b\\\\s"}'`);
  });
  it('doubles single quotes and quotes the column', () => {
    expect(pathSql('Order "Items"', ["it's"])).toBe(`"Order ""Items""" #>> '{it''s}'`);
  });
  it('prints numbers as integers', () => {
    expect(pathSql('p', [3])).toBe(`"p" #>> '{3}'`);
  });
  it("a key spelled null is quoted, any case (unquoted, the array literal would read SQL NULL)", () => {
    expect(pathLiteral(['null', 'Null', 'nULL'])).toBe(`'{"null","Null","nULL"}'`);
    expect(pathLiteral(['nullable', 'xnull'])).toBe(`'{nullable,xnull}'`);
  });
  it('a numeric-string key prints as the number does: Postgres reads it as a key on an object, an index on an array', () => {
    expect(pathLiteral(['0', 0, '-1'])).toBe(`'{0,0,-1}'`);
    // The display tells them apart.
    expect(pathText(['0'])).toBe('["0"]');
    expect(pathText([0])).toBe('[0]');
  });
  it('refuses a path number that is no number (NaN, ±Infinity): a TypeError, as quoteIdent refuses bad names', () => {
    for (const n of [NaN, Infinity, -Infinity]) {
      expect(() => pathLiteral(['a', n]), String(n)).toThrow(TypeError);
      expect(() => pathSql('p', [n]), String(n)).toThrow(TypeError);
    }
  });
  it('pathLiteral: the text-array literal alone, quoted for SQL (the JSON view nests reads of a parsed string)', () => {
    expect(pathLiteral(['data', 'lines', 0, 'id'])).toBe(`'{data,lines,0,id}'`);
    expect(pathLiteral(["it's", 'a,b'])).toBe(`'{it''s,"a,b"}'`);
    expect(pathLiteral([])).toBe(`'{}'`);
  });
  it('#> for the JSON itself (at path exists: #> … IS NOT NULL, as main runs it)', () => {
    expect(pathSql('payload', ['refund', 0], '#>')).toBe(`"payload" #> '{refund,0}'`);
    expect(pathSql('Order "Items"', ["it's"], '#>')).toBe(`"Order ""Items""" #> '{it''s}'`);
  });
});

describe('looksUnixTime', () => {
  it('needs a time-like key and a plausible number', () => {
    expect(looksUnixTime('created', 1793813327)).toBe(true);
    expect(looksUnixTime('expires_at', 1793813327)).toBe(true);
    expect(looksUnixTime('amount', 1793813327)).toBe(false);
    expect(looksUnixTime('created', 5)).toBe(false);
    expect(looksUnixTime('created', '1793813327')).toBe(false);
    expect(looksUnixTime(0, 1793813327)).toBe(false);
  });
  it('its bounds: 1e9 (2001-09-09) to 2e10 (2603), both included', () => {
    expect(looksUnixTime('created', 1e9)).toBe(true);
    expect(looksUnixTime('created', 1e9 - 1)).toBe(false);
    expect(looksUnixTime('created', 2e10)).toBe(true);
    expect(looksUnixTime('created', 2e10 + 1)).toBe(false);
    for (const v of [NaN, Infinity]) expect(looksUnixTime('created', v), String(v)).toBe(false);
  });
});

describe('jsonInString', () => {
  it('parses objects and arrays held in strings', () => {
    expect(jsonInString('{"gift":true}')).toEqual({ gift: true });
    expect(jsonInString(' [1,2]')).toEqual([1, 2]);
  });
  it('returns undefined otherwise', () => {
    expect(jsonInString('{nope')).toBeUndefined();
    expect(jsonInString('42')).toBeUndefined();
    expect(jsonInString(42)).toBeUndefined();
  });
});

describe('quoteIdent', () => {
  it('quotes and doubles inner quotes', () => {
    expect(quoteIdent('Order "Items"')).toBe('"Order ""Items"""');
    expect(quoteIdent('plain')).toBe('"plain"');
    expect(quoteIdent('a b.c')).toBe('"a b.c"');
    expect(quoteIdent('Kunden Ünï 日本')).toBe('"Kunden Ünï 日本"');
    expect(quoteIdent('"')).toBe('""""');
  });
  it('rejects an empty identifier and NUL', () => {
    expect(() => quoteIdent('')).toThrow(TypeError);
    expect(() => quoteIdent('a\0b')).toThrow(TypeError);
  });
});
