import { describe, expect, test } from 'vitest';
import { JsonNum } from '../redis/view';
import { clipText, isJsonText, jsonMaskText, jsonPreview, looksJsonContainer, parseJson, parseJsonInfo, secretKey } from './json-text';

// JSON read as text, never parsed (no number ever changes on its way to the screen or a copy): the cell's
// one-line preview and whether a text is JSON at all.

const text = (s: string, max?: number) => jsonPreview(s, max)?.map((t) => t.s).join('') ?? null;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('jsonPreview', () => {
  test('an object: keys, strings, numbers, literals in their colors; nested ones folded', () => {
    const toks = jsonPreview('{"plan":"pro","seats":12,"sso":true,"limits":{"a":1},"tags":["x","y","z"],"none":null}')!;
    expect(toks.map((t) => t.s).join('')).toBe('{"plan": "pro", "seats": 12, "sso": true, "limits": {…}, "tags": […3], "none": null}');
    expect(toks.find((t) => t.s === '"plan"')?.t).toBe('k');
    expect(toks.find((t) => t.s === '"pro"')?.t).toBe('s');
    expect(toks.find((t) => t.s === '12')?.t).toBe('n');
    expect(toks.find((t) => t.s === 'true')?.t).toBe('l');
    expect(toks.find((t) => t.s === 'null')?.t).toBe('l');
    expect(toks.find((t) => t.s === '{…}')?.t).toBe('fo');
    expect(toks.find((t) => t.s === '[…3]')?.t).toBe('fo');
  });

  test('numbers exactly as written: past 2^53, many decimals, exponents', () => {
    expect(text('{"id": 12345678901234567890, "x": 0.1000000000000000000001, "e": -1.5E+400, "z": -0}'))
      .toBe('{"id": 12345678901234567890, "x": 0.1000000000000000000001, "e": -1.5E+400, "z": -0}');
    expect(text('12345678901234567890')).toBe('12345678901234567890');
    expect(text('[9007199254740993, 1e-7]')).toBe('[9007199254740993, 1e-7]');
  });

  test('nested arrays fold with their count; empty ones show empty; whitespace as Postgres prints it or not', () => {
    expect(text('[1, "a", {"b": 2}, [], {}, [[1, 2], [3]]]')).toBe('[1, "a", {…}, [], {}, […2]]');
    expect(text('{\n  "a" : [ [1,2] , [3] ]\n}')).toBe('{"a": […2]}');
    expect(text('"hi"')).toBe('"hi"');
    expect(text('{}')).toBe('{}');
    expect(text('  [ ]  ')).toBe('[]');
  });

  test('strings shown as written (escapes kept), cut long', () => {
    expect(text('{"q": "say \\"hi\\"\\n"}')).toBe('{"q": "say \\"hi\\"\\n"}');
    const long = text(`{"s": "${'x'.repeat(500)}"}`, 200)!;
    expect(long.length).toBeLessThan(110);
    expect(long).toMatch(/^\{"s": "x+…"\}$/);
  });

  test('cut short: a 64 KB value builds a few tokens', () => {
    const big = `{${Array.from({ length: 5000 }, (_, i) => `"k${i}": "${'v'.repeat(50)}"`).join(', ')}}`;
    const out = text(big, 200)!;
    expect(out.length).toBeLessThan(400);
    expect(out.endsWith(', …}')).toBe(true);
  });

  test('never splits a surrogate pair, written or escaped', () => {
    expect(text(`{"s": "${'😀'.repeat(100)}"}`)).not.toMatch(LONE_SURROGATE);
    const escaped = text(`{"s": "${'\\ud83d\\ude00'.repeat(100)}"}`)!;
    expect(escaped).toMatch(/(\\ud83d\\ude00)+…"\}$/);
  });

  test('not JSON, or cut in the middle: null (the cell shows the text)', () => {
    for (const bad of ['{"a": [1, 2', '{"a" 1}', 'nope', '{"a": 1,, "b": 2}', '', '[1, 2]]x'.slice(0, 3)]) expect(text(bad), bad).toBeNull();
  });

  test('trailing junk: not one JSON value, no preview — whitespace around it is fine', () => {
    for (const bad of ['{"a": 1} x', '[1, 2] [3]', '{"a": 1}}', '"hi" x', '[] ,']) expect(text(bad), bad).toBeNull();
    expect(text(' {"a": 1}\n ')).toBe('{"a": 1}');
    // Cut short by the width: what wasn't shown is still read to the end.
    const big = `{${Array.from({ length: 200 }, (_, i) => `"k${i}": ${i}`).join(', ')}}`;
    expect(text(big, 40)?.endsWith(', …}')).toBe(true);
    expect(text(`${big} junk`, 40)).toBeNull();
    expect(text(`${big.slice(0, -1)}, "x": }`, 40)).toBeNull();
  });
});

describe('isJsonText', () => {
  test('whole values only', () => {
    for (const ok of ['{}', '[]', '"x"', '12345678901234567890', 'true', 'null', ' {"a": [1, {"b": [true, null]}]} ', '[1e5, -0.5]']) expect(isJsonText(ok), ok).toBe(true);
    for (const bad of ['[1,]', '{"a":1}x', '[abc', '{"a":1,}', '"unterminated', '{a: 1}', '01', '1.', '.5', '', ' ', '[1] [2]']) expect(isJsonText(bad), bad).toBe(false);
  });

  test('deep nesting reads without a stack overflow', () => {
    expect(isJsonText(`${'['.repeat(50_000)}${']'.repeat(50_000)}`)).toBe(true);
    expect(isJsonText(`${'['.repeat(50_000)}${']'.repeat(49_999)}`)).toBe(false);
  });

  test('looksJsonContainer: text that starts an object or an array', () => {
    expect(looksJsonContainer('  {"a": 1}')).toBe(true);
    expect(looksJsonContainer('[1]')).toBe(true);
    expect(looksJsonContainer('pro')).toBe(false);
  });
});

describe('parseJson (a lossless tree for the inspector\'s JSON views)', () => {
  test('numbers kept as their source text: past 2^53, trailing zeros, exponents — never through a double', () => {
    const v = parseJson('{"id": 12345678901234567890, "total": 248.00, "e": -1.5E+400, "small": 9007199254740993, "z": -0}') as Record<string, unknown>;
    for (const [k, text] of [['id', '12345678901234567890'], ['total', '248.00'], ['e', '-1.5E+400'], ['small', '9007199254740993'], ['z', '-0']]) {
      expect(v[k!], k).toBeInstanceOf(JsonNum);
      expect((v[k!] as JsonNum).text, k).toBe(text);
    }
    expect((parseJson('12345678901234567890') as JsonNum).text).toBe('12345678901234567890');
  });

  test('strings decoded, literals, arrays and objects in order', () => {
    expect(parseJson('{"q": "say \\"hi\\"\\n\\u00e9", "ok": true, "no": false, "none": null, "list": [1, "a", [], {}]}')).toEqual({
      q: 'say "hi"\né', ok: true, no: false, none: null, list: [new JsonNum('1'), 'a', [], {}]
    });
    expect(parseJson('  [ ]  ')).toEqual([]);
    expect(parseJson('"x"')).toBe('x');
    // A key repeated (json keeps them): the last one, as JSON.parse.
    expect(parseJson('{"a": 1, "a": 2}')).toEqual({ a: new JsonNum('2') });
  });

  test('parseJsonInfo says whether a key repeated (a json column keeps them; the JSON view notes it, item 13)', () => {
    expect(parseJsonInfo('{"a": 1, "b": {"c": 2, "c": 3}}')).toEqual({ value: { a: new JsonNum('1'), b: { c: new JsonNum('3') } }, duplicates: true });
    expect(parseJsonInfo('{"a": 1, "b": [{"a": 2}, {"a": 3}]}').duplicates).toBe(false);
    expect(parseJsonInfo('[1').value).toBeUndefined();
  });

  test('secretKey: the secret names, read on JSON keys (one definition, shared with the JSON view)', () => {
    expect(['password', 'api_key', 'customer_email', 'token'].every(secretKey)).toBe(true);
    expect(['name', 'status', 'key'].some(secretKey)).toBe(false);
  });

  test('a "__proto__" key is a key like any other, never the object\'s prototype', () => {
    const v = parseJson('{"__proto__": {"polluted": true}, "constructor": 1}') as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((v as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('every escape read as JSON.parse would: \\" \\\\ \\/ \\b \\f \\n \\r \\t, \\u units (a pair makes its character)', () => {
    expect(parseJson('["\\"\\\\\\/\\b\\f\\n\\r\\t", "\\u00e9\\ud83d\\ude00", "plain 😀"]')).toEqual(['"\\/\b\f\n\r\t', 'é😀', 'plain 😀']);
    expect(parseJson('{"\\u0065mail": 1}')).toEqual({ email: new JsonNum('1') });
  });

  test('not JSON (or cut at 64 KB): undefined', () => {
    for (const bad of ['{"a": [1, 2', '{"a" 1}', 'nope', '[1,]', '{"a":1}x', '01', '', ' ', '[1] [2]', '["\\x"]', '["\\u12"]', '{"\\q": 1}']) expect(parseJson(bad), bad).toBeUndefined();
  });

  test('deep nesting parses without a stack overflow', () => {
    let v = parseJson(`${'['.repeat(50_000)}${']'.repeat(50_000)}`);
    let depth = 0;
    while (Array.isArray(v) && v.length > 0) { v = v[0]; depth++; }
    expect(depth).toBe(49_999);
    expect(parseJson(`${'['.repeat(50_000)}${']'.repeat(49_999)}`)).toBeUndefined();
  });
});

describe('jsonMaskText (a key on the path that names a secret masks what is under it)', () => {
  const secret = (k: string) => /pass(word)?|token|email/i.test(k);
  test('the values under a masked key read as dots; everything else stays exactly as written', () => {
    const src = '{"email": "mara@lindqvist.example", "n": 12345678901234567890, "deep": {"password": {"x": [1, 2]}, "ok": "yes"}, "list": [{"token": 7}]}';
    expect(jsonMaskText(src, secret)).toBe('{"email": "••••••••", "n": 12345678901234567890, "deep": {"password": "••••••••", "ok": "yes"}, "list": [{"token": "••••••••"}]}');
  });

  test('nothing to hide stays: null and "" under a masked key, a text with no such key returned as it is', () => {
    expect(jsonMaskText('{"email": null, "token": ""}', secret)).toBe('{"email": null, "token": ""}');
    const plain = '{\n  "a": 1\n}';
    expect(jsonMaskText(plain, secret)).toBe(plain);
  });

  test('a key matched after its escapes are read (\\u0065mail is email)', () => {
    expect(jsonMaskText('{"\\u0065mail": "x@y"}', secret)).toBe('{"\\u0065mail": "••••••••"}');
  });

  test('not JSON (a value cut at 64 KB): masked whole — better hidden too many; deep nesting holds', () => {
    expect(jsonMaskText('{"email": "x', secret)).toBe('••••••••');
    const deep = `${'['.repeat(50_000)}{"token": 1}${']'.repeat(50_000)}`;
    expect(jsonMaskText(deep, secret)).toBe(`${'['.repeat(50_000)}{"token": "••••••••"}${']'.repeat(50_000)}`);
  });
});

describe('clipText', () => {
  test('at most max characters and an ellipsis, never half a surrogate pair', () => {
    expect(clipText('abcdef', 3)).toBe('abc…');
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('ab😀cd', 3)).toBe('ab…');
    expect(clipText('😀'.repeat(300), 401)).not.toMatch(LONE_SURROGATE);
  });
});
