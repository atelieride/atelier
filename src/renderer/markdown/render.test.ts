import { expect, test } from 'vitest';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { renderMarkdown, outlineOf, plainText } from './render';

type Node = Root | RootContent | ElementContent;
const all = (n: Node): Element[] => {
  const out: Element[] = [];
  const walk = (x: Node) => { if (x.type === 'element') out.push(x); if ('children' in x) for (const c of x.children) walk(c as Node); };
  walk(n);
  return out;
};
const tags = (n: Node) => all(n).map((e) => e.tagName);
const byTag = (n: Node, tag: string) => all(n).filter((e) => e.tagName === tag);
const text = (n: Node): string => n.type === 'text' ? n.value : 'children' in n ? (n.children as Node[]).map(text).join('') : '';

test('CommonMark and GFM: headings, emphasis, tables, task lists, strikethrough, autolinks, footnotes', () => {
  const { tree } = renderMarkdown([
    '# Title', '', 'Some **bold**, _em_, ~~gone~~ and `code`. Visit https://example.com.', '',
    '| A | B |', '| --- | ---: |', '| 1 | 2 |', '',
    '- [x] done', '- [ ] open', '', 'Note[^1].', '', '[^1]: The note.'
  ].join('\n'));
  const t = tags(tree);
  for (const x of ['h1', 'strong', 'em', 'del', 'code', 'table', 'thead', 'tbody', 'ul', 'li', 'input', 'sup', 'section']) expect(t).toContain(x);
  expect(byTag(tree, 'a').some((a) => a.properties.href === 'https://example.com')).toBe(true);
  const boxes = byTag(tree, 'input');
  expect(boxes.map((b) => [b.properties.type, !!b.properties.checked, !!b.properties.disabled])).toEqual([['checkbox', true, true], ['checkbox', false, true]]);
});

test('every block carries its source lines in data-src', () => {
  const { tree } = renderMarkdown(['# Title', '', 'A paragraph', 'on two lines.', '', '```ts', 'let a = 1;', '```', '', '- one', '- two'].join('\n'));
  const src = (tag: string) => byTag(tree, tag).map((e) => e.properties.dataSrc);
  expect(src('h1')).toEqual(['1-1']);
  expect(src('p')).toEqual(['3-4']);
  expect(src('pre')).toEqual(['6-8']);
  expect(src('ul')).toEqual(['10-11']);
  expect(src('li')).toEqual(['10-10', '11-11']);
});

test('front matter: pairs are lifted out of the page, with their lines; the body lines stay right', () => {
  const r = renderMarkdown(['---', 'status: draft', 'owner: me', '---', '# Title'].join('\n'));
  expect(r.frontMatter).toEqual({ pairs: [{ key: 'status', value: 'draft' }, { key: 'owner', value: 'me' }], raw: 'status: draft\nowner: me', start: 1, end: 4 });
  expect(tags(r.tree)).not.toContain('hr');
  expect(byTag(r.tree, 'h1')[0]!.properties.dataSrc).toBe('5-5');
  const nested = renderMarkdown(['---', 'a:', '  b: 1', '---', 'x'].join('\n'));
  expect(nested.frontMatter).toEqual({ pairs: null, raw: 'a:\n  b: 1', start: 1, end: 4 });
  expect(renderMarkdown('# No front matter').frontMatter).toBeNull();
});

test('GitHub alerts become tagged boxes without their marker', () => {
  const { tree } = renderMarkdown(['> [!WARNING]', '> Mind the gap.', '', '> [!note] Inline title text', '', '> Just a quote'].join('\n'));
  const alerts = all(tree).filter((e) => e.properties.dataAlert);
  expect(alerts.map((a) => a.properties.dataAlert)).toEqual(['warning', 'note']);
  expect(text(alerts[0]!).trim()).toBe('Mind the gap.');
  expect(text(alerts[1]!).trim()).toBe('Inline title text');
  expect(byTag(tree, 'blockquote')).toHaveLength(1);
});

test('raw HTML: the allow-list stays, the rest is dropped and counted', () => {
  const r = renderMarkdown([
    '<details><summary>More</summary>', '', 'Hidden **text**', '', '</details>', '',
    'Press <kbd>⌘</kbd> <kbd>K</kbd>, H<sub>2</sub>O.', '',
    '<script>alert(1)</script>', '', '<iframe src="https://x"></iframe>', '',
    '<img src="a.png" onerror="alert(1)" style="width:9999px">', '',
    '<a href="javascript:alert(1)">bad</a> <a href="https://ok.dev" onclick="x()">ok</a>'
  ].join('\n'));
  const t = tags(r.tree);
  for (const x of ['details', 'summary', 'kbd', 'sub', 'img']) expect(t).toContain(x);
  expect(t).not.toContain('script');
  expect(t).not.toContain('iframe');
  expect(JSON.stringify(r.tree)).not.toContain('alert(1)');
  const img = byTag(r.tree, 'img')[0]!;
  expect(img.properties.onError).toBeUndefined();
  expect(img.properties.style).toBeUndefined();
  const links = byTag(r.tree, 'a');
  expect(links.find((a) => text(a) === 'bad')!.properties.href).toBeUndefined();
  expect(links.find((a) => text(a) === 'ok')!.properties.onClick).toBeUndefined();
  expect(r.dropped).toEqual(['script', 'iframe']);
});

test('footnote ids are prefixed once (links and targets agree)', () => {
  const { tree } = renderMarkdown('A[^n].\n\n[^n]: B.');
  const ref = byTag(tree, 'a').find((a) => String(a.properties.href).includes('fn-n'))!;
  const id = String(ref.properties.href).slice(1);
  expect(id).toBe('user-content-fn-n');
  expect(all(tree).some((e) => e.properties.id === id)).toBe(true);
});

test('code blocks keep their fence name as language-* class', () => {
  const { tree } = renderMarkdown('```ts {1}\nlet a\n```');
  const code = byTag(tree, 'code')[0]!;
  expect(code.properties.className).toEqual(['language-ts']);
});

test('outline: h2 and h3 with GitHub slugs and lines; h1s when there is no h2', () => {
  const { tree } = renderMarkdown(['# Doc', '## Goals', '### Sub', '## Goals', '#### Deep'].join('\n'));
  expect(outlineOf(tree)).toEqual([
    { level: 2, text: 'Goals', slug: 'goals', line: 2 },
    { level: 3, text: 'Sub', slug: 'sub', line: 3 },
    { level: 2, text: 'Goals', slug: 'goals-1', line: 4 }
  ]);
  expect(outlineOf(renderMarkdown('# One\n\n# Two\n\n### x').tree).map((h) => h.text)).toEqual(['One', 'Two']);
});

test('plain text for word counts skips code blocks', () => {
  const { tree } = renderMarkdown('Hello **big** world\n\n```\nnot counted here\n```\n\n- item');
  expect(plainText(tree).split(/\s+/).filter(Boolean)).toEqual(['Hello', 'big', 'world', 'item']);
});
