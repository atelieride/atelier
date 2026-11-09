import { describe, expect, test } from 'vitest';
import { containerAt, foldAt, levelContainers, mapScan, pathAt, scanJson, startOfPath, valueAt } from './scan';

const DOC = [
  '{',
  '  "name": "orbit",',
  '  "server": {',
  '    "port": 8080,',
  '    "cors": { "origins": ["a{", "b]"], "on": true }',
  '  },',
  '  // "x": [',
  '  "list": [',
  '    1,',
  '    [2, 3]',
  '  ]',
  '}'
].join('\n');

const lineFrom = (text: string, n: number) => text.split('\n').slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
const lineTo = (text: string, n: number) => lineFrom(text, n) + text.split('\n')[n - 1]!.length;

describe('scanJson', () => {
  test('containers: brackets in strings and comments ignored, counts, depths, keys', () => {
    const s = scanJson(DOC);
    expect(s.containers.map((c) => [c.kind, c.depth, c.count, c.key])).toEqual([
      ['object', 0, 3, null], ['object', 1, 2, 'server'], ['object', 2, 2, 'cors'], ['array', 3, 2, 'origins'],
      ['array', 1, 2, 'list'], ['array', 2, 2, 1]
    ]);
    expect(DOC[s.containers[0]!.close]).toBe('}');
    expect(s.containers[0]!.close).toBe(DOC.length - 1);
  });

  test('tolerant: unclosed containers, stray brackets and trailing commas', () => {
    const s = scanJson('{\n  "a": [1, 2,\n  "b": ]\n');
    expect(s.containers.map((c) => [c.kind, c.close >= 0])).toEqual([['object', false], ['array', true]]);
    expect(s.containers[1]!.count).toBe(3);
    expect(scanJson('[1, 2,]').containers[0]!.count).toBe(2);
    expect(scanJson('[]').containers[0]!.count).toBe(0);
    expect(scanJson('}{').containers).toHaveLength(1);
  });
});

describe('mapScan', () => {
  test('every offset after the change moves with it; keys and counts stay', () => {
    const s = scanJson(DOC);
    const shift = 7;
    const at = DOC.indexOf('"list"');
    const m = mapScan(s, (p) => (p >= at ? p + shift : p));
    expect(m.containers.map((c) => c.key)).toEqual(s.containers.map((c) => c.key));
    expect(m.containers[0]!.close).toBe(s.containers[0]!.close + shift);
    expect(m.containers[1]!.open).toBe(s.containers[1]!.open);
    expect(m.containers.at(-2)!.starts).toEqual(s.containers.at(-2)!.starts.map((p) => p + shift));
    expect(m.start).toBe(s.start);
  });
});

describe('foldAt', () => {
  const s = scanJson(DOC);
  test('a line that opens a container closed on a later line folds from after the bracket to the closing one', () => {
    const f = foldAt(s, lineFrom(DOC, 3), lineTo(DOC, 3))!;
    expect(DOC.slice(f.from - 1, f.from)).toBe('{');
    expect(DOC[f.to]).toBe('}');
    expect(f).toMatchObject({ kind: 'object', count: 2 });
    expect(foldAt(s, lineFrom(DOC, 1), lineTo(DOC, 1))).toMatchObject({ from: 1, to: DOC.length - 1, count: 3 });
  });
  test('nothing for one-line containers and lines without an opening', () => {
    expect(foldAt(s, lineFrom(DOC, 5), lineTo(DOC, 5))).toBeNull();
    expect(foldAt(s, lineFrom(DOC, 4), lineTo(DOC, 4))).toBeNull();
    expect(foldAt(s, lineFrom(DOC, 7), lineTo(DOC, 7))).toBeNull();
  });
  test('an unclosed container does not fold', () => {
    const t = '{\n  "a": [\n    1\n';
    expect(foldAt(scanJson(t), 0, 1)).toBeNull();
  });
});

describe('levelContainers', () => {
  test('the containers at a depth (the root is 0)', () => {
    const s = scanJson(DOC);
    expect(levelContainers(s, 1).map((c) => c.key)).toEqual(['server', 'list']);
    expect(levelContainers(s, 2).map((c) => c.key)).toEqual(['cors', 1]);
  });
});

describe('pathAt', () => {
  const s = scanJson(DOC);
  const at = (needle: string, d = 1) => pathAt(s, DOC.indexOf(needle) + d).path;
  test('the path of the entry under the cursor', () => {
    expect(at('"port"')).toEqual(['server', 'port']);
    expect(at('8080')).toEqual(['server', 'port']);
    expect(at('"b]"')).toEqual(['server', 'cors', 'origins', 1]);
    expect(at('true')).toEqual(['server', 'cors', 'on']);
    expect(at('3]')).toEqual(['list', 1, 1]);
    expect(at('"name"', 0)).toEqual(['name']);
  });
  test('inside a container before its first entry, or outside the root', () => {
    expect(pathAt(s, 1).path).toEqual([]);
    expect(pathAt(s, 0).path).toEqual([]);
    expect(pathAt(s, DOC.indexOf('"list": [') + 9).path).toEqual(['list']);
  });
  test('a broken document still gives a path', () => {
    const t = '{\n  "a": {\n    "b": [1, 2,,\n';
    expect(pathAt(scanJson(t), t.indexOf('2')).path).toEqual(['a', 'b', 1]);
  });
});

describe('containerAt / startOfPath / valueAt', () => {
  const s = scanJson(DOC);
  test('the container a path names', () => {
    expect(containerAt(s, ['server', 'cors'])?.count).toBe(2);
    expect(containerAt(s, ['server', 'port'])).toBeNull();
    expect(containerAt(s, [])?.depth).toBe(0);
  });
  test('where an entry starts', () => {
    expect(DOC.slice(startOfPath(s, ['server', 'cors', 'on'])!, startOfPath(s, ['server', 'cors', 'on'])! + 4)).toBe('"on"');
    expect(DOC.slice(startOfPath(s, ['list', 1])!).startsWith('[2, 3]')).toBe(true);
    expect(startOfPath(s, [])).toBe(0);
    expect(startOfPath(s, ['nope'])).toBeNull();
  });
  test('the scalar after an entry start', () => {
    expect(valueAt(DOC, DOC.indexOf('"name"'), true)).toEqual({ type: 'string', length: 5 });
    expect(valueAt(DOC, DOC.indexOf('"port"'), true)).toEqual({ type: 'number' });
    expect(valueAt(DOC, DOC.indexOf('true'), false)).toEqual({ type: 'boolean' });
    expect(valueAt('[null]', 1, false)).toEqual({ type: 'null' });
    expect(valueAt('{"a": ', 1, true)).toBeNull();
    expect(valueAt('["abc', 1, false)).toEqual({ type: 'string' });
  });
});
