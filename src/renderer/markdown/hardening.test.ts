// Review findings (Security): untrusted Markdown can't forge the preview's own markers, crash it,
// stall the highlighter or reach files outside the project.
import { expect, test } from 'vitest';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { renderMarkdown } from './render';
import { fenceLanguage } from './text';
import { languageFor } from '@shared/languages';
import { createHighlighter, type WorkerLike } from '../editor/highlighter';

type Node = Root | RootContent | ElementContent;
const all = (n: Node): Element[] => {
  const out: Element[] = [];
  const walk = (x: Node) => { if (x.type === 'element') out.push(x); if ('children' in x) for (const c of x.children) walk(c as Node); };
  walk(n);
  return out;
};

test('raw HTML cannot forge an alert or source lines (only the parser sets them)', () => {
  const { tree } = renderMarkdown([
    '<div data-alert="__proto__">a</div>', '', '<div data-alert="note some-class">b</div>', '',
    '<div data-src="1-9999">c</div>', '', '> [!TIP]', '> real'
  ].join('\n'));
  const els = all(tree);
  expect(els.filter((e) => e.properties.dataAlert).map((e) => e.properties.dataAlert)).toEqual(['tip']);
  expect(els.filter((e) => e.tagName === 'div' && !e.properties.dataAlert).every((e) => e.properties.dataSrc === undefined)).toBe(true);
  expect(els.find((e) => e.properties.dataAlert === 'tip')!.properties.dataSrc).toBe('7-8');
});

test('picture/source never reach the page (srcset would bypass the project-confined image loader); img stays', () => {
  const { tree } = renderMarkdown('<picture><source srcset="/Users/me/Desktop/x.png"><img src="a.png" alt="A"></picture>');
  const tags = all(tree).map((e) => e.tagName);
  expect(tags).not.toContain('source');
  expect(tags).toContain('img');
});

test('raw HTML cannot take the window\'s Tab order or access keys', () => {
  const { tree } = renderMarkdown('<span tabindex="1" accesskey="k">x</span> <a href="https://a.dev" tabindex="2">y</a>');
  for (const e of all(tree)) { expect(e.properties.tabIndex).toBeUndefined(); expect(e.properties.accessKey).toBeUndefined(); }
});

test('dropped raw HTML is counted per element, named once per tag', () => {
  const r = renderMarkdown('<script>a</script>\n\n<script>b</script>\n\n<iframe></iframe>');
  expect(r.dropped).toEqual(['script', 'iframe']);
  expect(r.droppedCount).toBe(3);
});

test('code blocks are numbered in order (the highlighter colors the first 200 only)', () => {
  const { tree } = renderMarkdown('```ts\na\n```\n\n<pre data-block="0">x</pre>\n\n```js\nb\n```');
  expect(all(tree).filter((e) => e.tagName === 'pre').map((e) => e.properties.dataBlock)).toEqual([0, undefined, 1]);
});

test('names of Object.prototype are not languages (a fence or file named constructor)', () => {
  for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    expect(fenceLanguage(n)).toBeNull();
    expect(languageFor(`/p/a.${n}`)).toBeNull();
  }
});

test('a request the worker cannot take (postMessage throws) ends as uncolored and the queue goes on', async () => {
  const sent: string[] = [];
  const w: WorkerLike & { reply(): void } = {
    onmessage: null,
    postMessage(m: unknown) {
      const { id, code } = m as { id: number; code: string };
      if (code === 'bad') throw new Error('DataCloneError');
      sent.push(code);
      queueMicrotask(() => this.onmessage?.({ data: { id, result: null } } as MessageEvent));
    },
    terminate() {},
    reply() {}
  };
  const h = createHighlighter(() => w, () => 0);
  const bad = h.highlight('bad', 'ts', null);
  const good = h.highlight('good', 'ts', null);
  expect(await bad).toBeNull();
  expect(await good).toBeNull();
  expect(sent).toEqual(['good']);
});
