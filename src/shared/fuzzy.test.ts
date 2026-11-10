import { describe, expect, test } from 'vitest';
import { fuzzyFilter, fuzzyScore, textFilter, textScore } from './fuzzy';
import { bestTime } from '../../tests/support/timing';

describe('fuzzyScore', () => {
  test('characters in order', () => {
    expect(fuzzyScore('spk', 'SpeakerPanel.tsx')).not.toBeNull();
    expect(fuzzyScore('xsp', 'SpeakerPanel.tsx')).toBeNull(); // the x is the last letter
  });
  test('the file name counts more than the path; word starts more than the middle', () => {
    const items = ['app-ui/src/components/audio/SpeakerPanel.tsx', 'app-ui/src/speaker/index.ts', 'report-worker/src/services/transcription.service.ts'];
    expect(fuzzyFilter(items, 'speakpan', (x) => x)[0]).toBe('app-ui/src/components/audio/SpeakerPanel.tsx');
    expect(fuzzyFilter(items, 'trans', (x) => x)[0]).toBe('report-worker/src/services/transcription.service.ts');
  });
  test('case-insensitive, empty query → everything in the given order, limit', () => {
    expect(fuzzyScore('APP', 'app.tsx')).not.toBeNull();
    expect(fuzzyFilter(['a', 'b', 'c'], '', (x) => x, 2)).toEqual(['a', 'b']);
  });
  test('50,000 paths filtered in under 150 ms', () => {
    const many = Array.from({ length: 50000 }, (_, i) => `repo${i % 10}/src/module${i}/file${i}.ts`);
    expect(bestTime(() => fuzzyFilter(many, 'mod123fil', (x) => x))).toBeLessThan(150);
  });
});

// Free text (conversations, prompts, task titles): the query's words, each close-knit somewhere (bug 2026-11-02: a
// random "mcpcccccccccccccc" found conversations, its letters scattered across a 300-character first prompt).
describe('textScore', () => {
  const prompt = 'Hi, some overnight tasks, one after the other: check how the palette search works, since searching for '
    + 'something unrelated still finds sessions; then the components, the code cache, the conflicts, the folders, '
    + 'the MCP calls and the connection counter, calmly and with care.';
  test('letters scattered across a long text are no match (they were for fuzzyScore)', () => {
    expect(fuzzyScore('mcpcccccccccccccc', prompt)).not.toBeNull();
    expect(textScore('mcpcccccccccccccc', [prompt])).toBeNull();
    expect(textScore('zqxw', [prompt])).toBeNull();
  });
  test('a word, a word start, a few typos inside a word', () => {
    expect(textScore('mcp', ['Configure the MCP server'])).not.toBeNull();
    expect(textScore('palet', [prompt])).not.toBeNull();
    expect(textScore('wrkspace', ['Global workspace setting'])).not.toBeNull();
    expect(textScore('atlr', ['Atelier release'])).not.toBeNull();
    expect(textScore('dply', ['deploy the site'])).not.toBeNull();
  });
  test('initials of words in a row ("flb" for "Fix login bug"), never letters spread over the text', () => {
    expect(textScore('flb', ['Fix login bug'])).not.toBeNull();
    expect(textScore('flb', ['Fix the login bug'])).toBeNull();
    expect(textScore('flb', ['fix-login-bug'])).not.toBeNull();
    expect(textScore('lb', ['Fix login bug'])).not.toBeNull();
    expect(textScore('flb', ['Fix login bug'])!).toBeLessThan(textScore('fix', ['Fix login bug'])!);
  });
  test('two letters must be together', () => {
    expect(textScore('ws', ['workspace'])).toBeNull();
    expect(textScore('mc', ['the MCP'])).not.toBeNull();
  });
  test('every word of the query, in any order and any field', () => {
    expect(textScore('sito deploy', ['deploy del sito'])).not.toBeNull();
    expect(textScore('deploy main', ['deploy del sito', 'main'])).not.toBeNull();
    expect(textScore('sito zebra', ['deploy del sito'])).toBeNull();
  });
  test('accents and case do not matter', () => {
    expect(textScore('perche', ['Perché no'])).not.toBeNull();
    expect(textScore('PERCHÉ', ['perche no'])).not.toBeNull();
  });
  test('a whole word beats a word inside another, which beats letters close together; earlier fields count more', () => {
    const word = textScore('log', ['the log file'])!;
    const inside = textScore('log', ['catalog'])!;
    const close = textScore('lgn', ['login'])!;
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(close);
    expect(textScore('log', ['log', 'x'])!).toBeGreaterThan(textScore('log', ['x', 'log'])!);
  });
  test('empty query: 0 for everything', () => {
    expect(textScore('  ', ['anything'])).toBe(0);
  });
  test('textFilter keeps the given order among equal matches and drops the rest', () => {
    const items = ['beta log', 'alpha log', 'catalog', 'nothing'];
    expect(textFilter(items, 'log', (x) => [x])).toEqual(['beta log', 'alpha log', 'catalog']);
    expect(textFilter(items, '', (x) => [x], 2)).toEqual(['beta log', 'alpha log']);
  });
  test('200 conversations of 300 characters, four fields, in under 30 ms', () => {
    const many = Array.from({ length: 200 }, (_, i) => [`Title ${i}`, prompt, `feat/branch-${i}`, `pkg${i}/`]);
    expect(bestTime(() => textFilter(many, 'mcp contatore', (x) => x))).toBeLessThan(30);
  });
});
