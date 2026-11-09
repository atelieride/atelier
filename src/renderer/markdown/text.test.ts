import { expect, test } from 'vitest';
import { fenceLanguage, parseFrontMatter, readingStats, slugger, statusTone } from './text';

test('GitHub slugs: lowercase, punctuation out, spaces to dashes, repeats numbered', () => {
  const s = slugger();
  expect(s('Offline sync — design')).toBe('offline-sync--design');
  expect(s('Goals')).toBe('goals');
  expect(s('Goals')).toBe('goals-1');
  expect(s('Goals')).toBe('goals-2');
  expect(s("What's new? (v2.0)")).toBe('whats-new-v20');
  expect(s('Caffè & più')).toBe('caffè--più');
  expect(s('Spaced  out')).toBe('spaced--out');
  expect(slugger()('Goals')).toBe('goals');
});

test('fence names map to the editor languages, aliases included; unknown ones stay plain', () => {
  expect(fenceLanguage('ts')).toBe('typescript');
  expect(fenceLanguage('TypeScript')).toBe('typescript');
  expect(fenceLanguage('tsx {1,3}')).toBe('tsx');
  expect(fenceLanguage('bash')).toBe('shellscript');
  expect(fenceLanguage('sh')).toBe('shellscript');
  expect(fenceLanguage('zsh')).toBe('shellscript');
  expect(fenceLanguage('console')).toBe('shellscript');
  expect(fenceLanguage('py')).toBe('python');
  expect(fenceLanguage('yml')).toBe('yaml');
  expect(fenceLanguage('js')).toBe('javascript');
  expect(fenceLanguage('json')).toBe('json');
  expect(fenceLanguage('md')).toBe('markdown');
  expect(fenceLanguage('rs')).toBe('rust');
  expect(fenceLanguage('mermaid')).toBeNull();
  expect(fenceLanguage('')).toBeNull();
  expect(fenceLanguage(null)).toBeNull();
});

test('front matter: flat key/value pairs become pills; anything nested stays raw', () => {
  expect(parseFrontMatter('status: draft\nowner: platform\n')).toEqual([{ key: 'status', value: 'draft' }, { key: 'owner', value: 'platform' }]);
  expect(parseFrontMatter('title: "Hello: world"\ntags: [a, b]\n# a comment\n')).toEqual([{ key: 'title', value: 'Hello: world' }, { key: 'tags', value: '[a, b]' }]);
  expect(parseFrontMatter("title: 'quoted'")).toEqual([{ key: 'title', value: 'quoted' }]);
  expect(parseFrontMatter('owner:\n  name: x')).toBeNull();
  expect(parseFrontMatter('notes: |\n  long')).toBeNull();
  expect(parseFrontMatter('- a\n- b')).toBeNull();
  expect(parseFrontMatter('')).toBeNull();
  expect(parseFrontMatter(Array.from({ length: 13 }, (_, i) => `k${i}: v`).join('\n'))).toBeNull();
});

test('status values get a tone; other keys none', () => {
  expect(statusTone('status', 'Draft')).toBe('waiting');
  expect(statusTone('status', 'in progress')).toBe('waiting');
  expect(statusTone('Status', 'approved')).toBe('done');
  expect(statusTone('status', 'shipped')).toBe('done');
  expect(statusTone('status', 'blocked')).toBe('error');
  expect(statusTone('status', 'whatever')).toBeNull();
  expect(statusTone('owner', 'done')).toBeNull();
});

test('reading stats: words of the rendered text and minutes at 230 words a minute (at least 1)', () => {
  expect(readingStats('Hello world')).toEqual({ words: 2, minutes: 1 });
  expect(readingStats("Don't stop — it's fine. 42 items, état-major")).toEqual({ words: 7, minutes: 1 });
  expect(readingStats('')).toEqual({ words: 0, minutes: 0 });
  expect(readingStats(Array.from({ length: 700 }, () => 'w').join(' '))).toEqual({ words: 700, minutes: 3 });
});
