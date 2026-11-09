import { describe, expect, test } from 'vitest';
import { crumbs, entriesLabel, formatPath, groupNumber, nodeInfo, segLabel, typeLabel, utf8Length } from './paths';
import { copyValue } from './copy';
import { parseJson, slimTree, stringOf, type JsonNode } from './parse';

describe('formatPath', () => {
  const p = ['server', 'cors', 'origins', 0];
  test('jq, JavaScript and JSON Pointer', () => {
    expect(formatPath(p, 'jq')).toBe('.server.cors.origins[0]');
    expect(formatPath(p, 'js')).toBe('data.server.cors.origins[0]');
    expect(formatPath(p, 'pointer')).toBe('/server/cors/origins/0');
  });
  test('names that are not identifiers, escapes, the root', () => {
    expect(formatPath(['node_modules/@babel/core', 'x-y', '$ok', '1a'], 'jq')).toBe('.["node_modules/@babel/core"]["x-y"]["$ok"]["1a"]');
    expect(formatPath(['a"b'], 'js')).toBe('data["a\\"b"]');
    expect(formatPath(['$ok', '_x1'], 'js')).toBe('data.$ok._x1');
    expect(formatPath(['a/b', 'c~d', ''], 'pointer')).toBe('/a~1b/c~0d/');
    expect(formatPath([], 'jq')).toBe('.');
    expect(formatPath([], 'js')).toBe('data');
    expect(formatPath([], 'pointer')).toBe('');
  });
});

describe('crumbs and labels', () => {
  test('a segment label: indices in brackets, the empty name quoted', () => {
    expect(segLabel(3)).toBe('[3]');
    expect(segLabel('port')).toBe('port');
    expect(segLabel('')).toBe('""');
  });
  test('every segment with the path up to it; deep paths keep the first, an ellipsis and the last four', () => {
    expect(crumbs(['a', 0]).map((c) => [c.label, c.path])).toEqual([['a', ['a']], ['[0]', ['a', 0]]]);
    const deep = crumbs(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(deep.map((c) => c.label)).toEqual(['a', '…', 'd', 'e', 'f', 'g']);
    expect(deep[1]!.path).toEqual(['a', 'b', 'c']);
    expect(crumbs(['a', 'b', 'c', 'd', 'e', 'f']).map((c) => c.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
  test('type labels', () => {
    expect(typeLabel({ type: 'string', length: 21 })).toBe('string · 21 chars');
    expect(typeLabel({ type: 'string', length: 1 })).toBe('string · 1 char');
    expect(typeLabel({ type: 'object', count: 1 })).toBe('object · 1 key');
    expect(typeLabel({ type: 'object', count: 1284 })).toBe('object · 1 284 keys');
    expect(typeLabel({ type: 'array', count: 4 })).toBe('array · 4 items');
    expect(typeLabel({ type: 'array', count: 10, objects: true })).toBe('array · 10 objects');
    expect(typeLabel({ type: 'number' })).toBe('number');
    expect(typeLabel({ type: 'null' })).toBe('null');
  });
  test('what a folded block hides', () => {
    expect(entriesLabel(3, 'object')).toBe('3 keys');
    expect(entriesLabel(1, 'object')).toBe('1 key');
    expect(entriesLabel(1, 'array')).toBe('1 item');
    expect(entriesLabel(1284, 'array')).toBe('1 284 items');
  });
  test('the type of a parsed value; arrays of objects say so', () => {
    const r = parseJson('{"s": "héllo", "n": 1, "a": [1], "o": [{}, {}], "e": [], "m": {"x": null}}', { jsonc: false });
    if (!r.ok) throw new Error('bad');
    expect(r.root.children!.map(nodeInfo)).toEqual([
      { type: 'string', length: 5 }, { type: 'number' }, { type: 'array', count: 1 }, { type: 'array', count: 2, objects: true },
      { type: 'array', count: 0 }, { type: 'object', count: 1 }
    ]);
    expect(nodeInfo(null)).toBeNull();
  });
  test('UTF-8 size of a text', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('è')).toBe(2);
    expect(utf8Length('€')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });
  test('thin-space groups', () => {
    expect(groupNumber(999)).toBe('999');
    expect(groupNumber(1284)).toBe('1 284');
    expect(groupNumber(41870)).toBe('41 870');
    expect(groupNumber(1234567)).toBe('1 234 567');
  });
});

describe('slim trees (strings without their decoded value, as the worker sends them)', () => {
  test('strings read from raw; everything else unchanged', () => {
    const r = parseJson('{"s": "a\\"b\\u00e8", "n": 2, "l": ["xyz"]}', { jsonc: false });
    if (!r.ok) throw new Error('bad');
    slimTree(r.root);
    const [s, , l] = r.root.children!;
    expect(s!.value).toBeUndefined();
    expect(stringOf(s!)).toBe('a"bè');
    expect(copyValue(s!)).toBe('a"bè');
    expect(nodeInfo(s!)).toEqual({ type: 'string', length: 4 });
    expect(l!.children![0]!.value).toBeUndefined();
    expect(r.root.children![1]!.value).toBe(2);
  });
});

describe('copyValue', () => {
  const root = (t: string): JsonNode => { const r = parseJson(t, { jsonc: true }); if (!r.ok) throw new Error('bad'); return r.root; };
  test('a string without its quotes, other scalars as written', () => {
    const r = root('{"s": "a\\"b", "n": 1.50, "b": false, "z": null}');
    expect(r.children!.map(copyValue)).toEqual(['a"b', '1.50', 'false', 'null']);
  });
  test('containers as JSON, 2-space indent, number literals kept, comments dropped', () => {
    const r = root('{ // c\n "pool": {"min": 2, "ratio": 1.0, "tags": ["a", {}], "e": []} }');
    expect(copyValue(r.children![0]!)).toBe('{\n  "min": 2,\n  "ratio": 1.0,\n  "tags": [\n    "a",\n    {}\n  ],\n  "e": []\n}');
  });
});
