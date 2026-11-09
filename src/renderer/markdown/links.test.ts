import { expect, test } from 'vitest';
import { classifyHref, imagePath, linkCandidate } from './links';

test('anchors scroll inside the page', () => {
  expect(classifyHref('#goals')).toEqual({ kind: 'anchor', id: 'goals' });
  expect(classifyHref('#caf%C3%A9')).toEqual({ kind: 'anchor', id: 'café' });
});

test('http(s) goes to the browser; every other scheme is inert', () => {
  expect(classifyHref('https://example.com/a?b=1')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' });
  expect(classifyHref('http://x.dev')).toEqual({ kind: 'url', url: 'http://x.dev' });
  for (const h of ['javascript:alert(1)', 'JAVASCRIPT:x', 'file:///etc/passwd', 'mailto:a@b.c', 'data:text/html,x', '//evil.com/x', 'vscode://file/x'])
    expect(classifyHref(h)).toEqual({ kind: 'inert' });
  expect(classifyHref('')).toEqual({ kind: 'inert' });
});

test('anything else is a project file, with #L lines when given', () => {
  expect(classifyHref('./storage.md')).toEqual({ kind: 'file', path: './storage.md', line: null, end: null });
  expect(classifyHref('../src/a.ts#L42')).toEqual({ kind: 'file', path: '../src/a.ts', line: 42, end: null });
  expect(classifyHref('a.ts#L10-L20')).toEqual({ kind: 'file', path: 'a.ts', line: 10, end: 20 });
  expect(classifyHref('a.ts#L10-20')).toEqual({ kind: 'file', path: 'a.ts', line: 10, end: 20 });
  expect(classifyHref('docs/a%20b.md#intro')).toEqual({ kind: 'file', path: 'docs/a b.md', line: null, end: null });
  expect(classifyHref('a.md?raw=1')).toEqual({ kind: 'file', path: 'a.md', line: null, end: null });
  expect(classifyHref('/docs/plan.md')).toEqual({ kind: 'file', path: '/docs/plan.md', line: null, end: null });
});

test('image paths: relative to the file folder (or the root with a leading slash), normalized; remote and other schemes are not files', () => {
  expect(imagePath('./assets/flow.png', '/p/docs/a.md', '/p')).toBe('/p/docs/assets/flow.png');
  expect(imagePath('../img/x.svg', '/p/docs/a.md', '/p')).toBe('/p/img/x.svg');
  expect(imagePath('/shots/one.png', '/p/docs/a.md', '/p')).toBe('/p/shots/one.png');
  expect(imagePath('a%20b.png?x=1#y', '/p/a.md', '/p')).toBe('/p/a b.png');
  expect(imagePath('x.png', 'untitled:1', '/p')).toBe('/p/x.png');
  expect(imagePath('https://img.shields.io/x.svg', '/p/a.md', '/p')).toBeNull();
  expect(imagePath('data:image/png;base64,AAAA', '/p/a.md', '/p')).toBeNull();
  expect(imagePath('', '/p/a.md', '/p')).toBeNull();
});

test('a file link resolves against the Markdown file folder, a leading slash against the project root', () => {
  expect(linkCandidate('./storage.md', '/p/docs/sync/design.md', '/p')).toEqual({ candidate: './storage.md', cwd: '/p/docs/sync' });
  expect(linkCandidate('/docs/plan.md', '/p/docs/sync/design.md', '/p')).toEqual({ candidate: 'docs/plan.md', cwd: '/p' });
  // An untitled tab has no folder: the project root.
  expect(linkCandidate('a.md', 'untitled:1', '/p')).toEqual({ candidate: 'a.md', cwd: '/p' });
});
