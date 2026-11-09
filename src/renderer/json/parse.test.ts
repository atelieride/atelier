import { describe, expect, test } from 'vitest';
import { findNode, nodeAt, nodeAtPath, parseJson, type JsonNode, type ParseResult } from './parse';

const ok = (r: ParseResult): JsonNode => {
  if (!r.ok) throw new Error(`expected a valid parse, got ${'error' in r ? r.error.message : 'empty'}`);
  return r.root;
};
const err = (text: string, jsonc = false) => {
  const r = parseJson(text, { jsonc });
  if (r.ok || !('error' in r)) throw new Error('expected an error');
  return r.error;
};

describe('parseJson: valid documents', () => {
  test('values, keys, ranges and lines', () => {
    const text = '{\n  "name": "orbit",\n  "port": 8080,\n  "on": true,\n  "off": null,\n  "list": [1, -2.5e3]\n}\n';
    const r = parseJson(text, { jsonc: false });
    const root = ok(r);
    expect(r.ok && r.nodes).toBe(8);
    expect(root).toMatchObject({ type: 'object', key: null, from: 0, line: 1, endLine: 7 });
    expect(root.to).toBe(text.lastIndexOf('}') + 1);
    const [name, port, on, off, list] = root.children!;
    expect(name).toMatchObject({ type: 'string', key: 'name', raw: '"orbit"', value: 'orbit', line: 2, endLine: 2 });
    expect(text.slice(name!.start, name!.to)).toBe('"name": "orbit"');
    expect(text.slice(name!.from, name!.to)).toBe('"orbit"');
    expect(port).toMatchObject({ type: 'number', raw: '8080', value: 8080, line: 3 });
    expect(on).toMatchObject({ type: 'boolean', value: true });
    expect(off).toMatchObject({ type: 'null', value: null, raw: 'null' });
    expect(list).toMatchObject({ type: 'array', key: 'list', line: 6, endLine: 6 });
    expect(list!.children!.map((c) => [c.key, c.raw, c.value])).toEqual([[0, '1', 1], [1, '-2.5e3', -2500]]);
    expect(list!.children![0]!.start).toBe(list!.children![0]!.from);
  });

  test('a scalar root, a BOM, escapes and unicode', () => {
    expect(ok(parseJson('  42 ', { jsonc: false }))).toMatchObject({ type: 'number', value: 42, from: 2, to: 4 });
    expect(ok(parseJson('﻿[]', { jsonc: false }))).toMatchObject({ type: 'array', children: [] });
    const s = ok(parseJson('"a\\n\\"b\\u00e8\\/"', { jsonc: false }));
    expect(s.value).toBe('a\n"bè/');
  });

  test('a multi-line container: line of its key, end line of its bracket', () => {
    const root = ok(parseJson('{\n  "a": {\n    "b": 1\n  }\n}', { jsonc: false }));
    expect(root.children![0]).toMatchObject({ key: 'a', line: 2, endLine: 4 });
  });

  test('deep nesting does not overflow the stack', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    expect(parseJson(deep, { jsonc: false }).ok).toBe(true);
  });

  test('JSONC: comments and trailing commas are allowed', () => {
    const root = ok(parseJson('{\n  // port\n  "a": 1, /* x */\n  "b": [1, 2,],\n}', { jsonc: true }));
    expect(root.children!.map((c) => c.key)).toEqual(['a', 'b']);
    expect(root.children![1]!.children).toHaveLength(2);
  });

  test('an empty or blank document is empty, not an error', () => {
    expect(parseJson('', { jsonc: false })).toEqual({ ok: false, empty: true });
    expect(parseJson(' \n\t', { jsonc: false })).toEqual({ ok: false, empty: true });
    expect(parseJson('// only a comment\n', { jsonc: true })).toEqual({ ok: false, empty: true });
  });
});

describe('parseJson: errors', () => {
  test('trailing comma before ] with its fix', () => {
    const text = '{\n  "a": [\n    1,\n    2,\n  ]\n}';
    const e = err(text);
    expect(e.message).toBe('Trailing comma before ]');
    expect(e.line).toBe(4);
    expect(e.col).toBe(6);
    expect(text.slice(e.from, e.to)).toBe(',');
    expect(e.fix).toEqual({ label: 'Remove the comma', from: e.from, to: e.from + 1, insert: '' });
  });

  test('trailing comma before }', () => {
    expect(err('{"a": 1,}').message).toBe('Trailing comma before }');
  });

  test('missing comma, with a fix that inserts it after the previous value', () => {
    const text = '[\n  "a"\n  "b"\n]';
    const e = err(text);
    expect(e.message).toBe('Missing comma');
    expect(e.line).toBe(3);
    expect(e.fix).toEqual({ label: 'Insert a comma', from: text.indexOf('"a"') + 3, to: text.indexOf('"a"') + 3, insert: ',' });
    expect(err('{"a": 1 "b": 2}').message).toBe('Missing comma');
  });

  test('property names', () => {
    expect(err('{a: 1}').message).toBe('Expected a property name in double quotes');
    expect(err("{'a': 1}").message).toBe('Single quotes are not JSON: use double quotes');
    expect(err('{"a" 1}').message).toBe('Expected : after the property name');
    expect(err('{,}').message).toBe('Expected a property name in double quotes');
  });

  test('values', () => {
    expect(err('{"a": }').message).toBe('Expected a value');
    expect(err('[1,,2]').message).toBe('Expected a value');
    expect(err("['x']").message).toBe('Single quotes are not JSON: use double quotes');
    const u = err('[True]');
    expect(u.message).toBe('Unexpected True');
    expect([u.from, u.to]).toEqual([1, 5]);
    expect(err('[1] ]').message).toBe('Extra content after the value');
  });

  test('numbers', () => {
    for (const bad of ['01', '1.', '-', '.5', '+1', '1e', '1.2.3']) expect(err(`[${bad}]`).message, bad).toBe('Invalid number');
  });

  test('strings', () => {
    const e = err('{"a": "abc\n}');
    expect(e.message).toBe('Unterminated string');
    expect(e.line).toBe(1);
    expect(err('"a\\qb"').message).toBe('Invalid escape \\q');
    expect(err('"a\\u12g4"').message).toBe('Invalid escape \\u12g4');
    expect(err('"a\tb"').message).toBe('Control character in a string');
  });

  test('comments in JSON, unterminated comments in JSONC', () => {
    const e = err('{\n  // hi\n  "a": 1\n}');
    expect(e.message).toBe('Comments are not allowed in JSON');
    expect(e.line).toBe(2);
    expect(err('[1 /* x', true).message).toBe('Unterminated comment');
  });

  test('end of file: position at the end', () => {
    const e = err('{\n  "a": [1, 2');
    expect(e.message).toBe('Unexpected end of file');
    expect([e.line, e.col]).toEqual([2, 13]);
    expect(e.from).toBe(e.to);
  });

  test('a stray closing bracket', () => {
    expect(err(']').message).toBe('Unexpected ]');
    expect(err('{"a": 1]').message).toBe('Unexpected ]');
  });
});

describe('nodeAt / nodeAtPath', () => {
  const text = '{\n  "server": {\n    "port": 8080,\n    "hosts": ["a", "b"]\n  }\n}';
  const root = ok(parseJson(text, { jsonc: false }));

  test('the innermost node at an offset, the key included', () => {
    expect(nodeAt(root, text.indexOf('"b"') + 1).map((n) => n.key)).toEqual([null, 'server', 'hosts', 1]);
    expect(nodeAt(root, text.indexOf('"port"')).map((n) => n.key)).toEqual([null, 'server', 'port']);
    expect(nodeAt(root, 0).map((n) => n.key)).toEqual([null]);
  });

  test('a node from its path, or the deepest existing ancestor', () => {
    expect(nodeAtPath(root, ['server', 'hosts', 0]).map((n) => n.key)).toEqual([null, 'server', 'hosts', 0]);
    expect(nodeAtPath(root, ['server', 'nope', 3]).map((n) => n.key)).toEqual([null, 'server']);
  });

  test('findNode: the node at exactly that path, or null (never an ancestor)', () => {
    expect(findNode(root, ['server', 'hosts', 1])?.value).toBe('b');
    expect(findNode(root, [])).toBe(root);
    expect(findNode(root, ['server', 'gone'])).toBeNull();
  });
});
