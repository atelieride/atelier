import { expect, test } from 'vitest';
import { buildVocabulary } from './vocabulary';

// whisper.cpp keeps only the last ~223 tokens of the hint: the most relevant terms go at the end.
test('most relevant at the end (project last), no duplicates, files and folders separated', () => {
  const v = buildVocabulary({
    project: 'atelier', branch: 'main', sessions: ['Fix login'],
    files: ['src/main/TerminalHub.ts', 'src/renderer/App.tsx'], identifiers: ['useEffect', 'TerminalHub']
  });
  expect(v).toBe('TerminalHub, useEffect, renderer, App.tsx, src, TerminalHub.ts, Fix login, main, atelier, Atelier, CLAUDE.md, Claude');
});

test('limit (600 by default) dropping the least relevant, without cutting a word', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `longIdentifier${i}`);
  const v = buildVocabulary({ project: 'p', branch: null, sessions: [], files: [], identifiers: ids });
  expect(v.length).toBeLessThanOrEqual(600);
  expect(v.endsWith(', longIdentifier0, p, Atelier, CLAUDE.md, Claude')).toBe(true);
  expect(v.split(', ').every((w) => ['p', 'Atelier', 'CLAUDE.md', 'Claude'].includes(w) || /^longIdentifier\d+$/.test(w))).toBe(true);
});

test('identifiers too short, numbers and common words excluded; HEAD branch ignored', () => {
  const v = buildVocabulary({ project: null, branch: 'HEAD', sessions: [], files: [], identifiers: ['id', 'x1', '12345', 'tsx', 'parseLine', 'snake_case_name'] });
  expect(v).toBe('snake_case_name, parseLine, Atelier, CLAUDE.md, Claude');
});

// Dictated "Claude" came out as "cloud": these terms are always there, at the very end, never dropped.
test('Claude, CLAUDE.md and Atelier always at the end, even with nothing else', () => {
  expect(buildVocabulary({ project: null, branch: null, sessions: [], files: [], identifiers: [] })).toBe('Atelier, CLAUDE.md, Claude');
});
