import { describe, expect, test } from 'vitest';
import type { Thread, ThreadItem } from '@shared/companion/types';
import { newThread } from '@shared/companion/thread';
import { answerCopy, copyOf, threadCopy, type CopyEl, type CopyNode } from './copy';
import { threadMarkdown } from './view';

// Ask's formatted copies: clean HTML (ClickUp, Word) and plain text, from a selection's
// nodes or from an answer's Markdown. Pure, so the DOM side only turns a Range into these nodes.

const el = (tag: string, attrs: Record<string, string> = {}, ...kids: CopyNode[]): CopyEl => ({ tag, attrs, kids });
const p = (...kids: CopyNode[]) => el('p', {}, ...kids);

describe('copyOf (a selection)', () => {
  test('paragraphs and inline formatting: tags only, no classes or styles; the text as it reads', () => {
    const nodes = [p('Uses ', el('strong', { class: 'x', style: 'color: red' }, 'TokenStore'), ' and ', el('em', {}, 'never'), ' ', el('code', {}, 'refresh()'), '.'), p('Second.')];
    expect(copyOf(nodes)).toEqual({
      html: '<p>Uses <strong>TokenStore</strong> and <em>never</em> <code>refresh()</code>.</p><p>Second.</p>',
      text: 'Uses TokenStore and never refresh().\n\nSecond.'
    });
  });

  test("the panel's chrome stays out: skipped parts, hidden glyphs, buttons, icons", () => {
    const nodes = [el('article', {},
      el('header', { 'data-copy': 'skip' }, 'Ask · Sonnet · read 2 files'),
      el('ol', {}, el('li', {}, el('span', { 'aria-hidden': 'true' }, '1'), el('span', {}, 'Step one'))),
      p('Body', el('svg', {}, el('path', {}))),
      el('div', {}, el('button', {}, 'Why?'), el('button', {}, 'Copy')))];
    expect(copyOf(nodes)).toEqual({ html: '<ol><li>Step one</li></ol><p>Body</p>', text: '1. Step one\n\nBody' });
  });

  test('a file chip copies as the reference written in the answer, in code', () => {
    const chip = el('button', { 'data-copy-text': 'src/auth/session.ts:58', 'data-copy-wrap': 'code' }, el('span', {}, 'session.ts'), el('span', {}, ':58'));
    expect(copyOf([p('See ', chip, ' for it.')])).toEqual({ html: '<p>See <code>src/auth/session.ts:58</code> for it.</p>', text: 'See src/auth/session.ts:58 for it.' });
  });

  test("a Detail box's header (a toggle) copies its title in bold, with the title's own formatting", () => {
    const head = el('button', { 'data-copy': 'keep', 'data-copy-wrap': 'strong' }, el('span', { 'data-copy': 'skip' }, 'Detail'), ' ', el('span', {}, 'Why ', el('code', {}, 'SKEW_MS')), el('svg', {}));
    expect(copyOf([el('div', {}, head, el('div', {}, p('Body.')))])).toEqual({ html: '<p><strong>Why <code>SKEW_MS</code></strong></p><p>Body.</p>', text: 'Why SKEW_MS\n\nBody.' });
  });

  test('lists: ordered from where they start (a selection of items 3–4), bullets as dashes', () => {
    const ol = el('ol', { start: '3' }, el('li', {}, 'three'), el('li', {}, 'four'));
    const ul = el('ul', {}, el('li', {}, 'a'), el('li', {}, el('strong', {}, 'b')));
    expect(copyOf([ol, ul])).toEqual({
      html: '<ol start="3"><li>three</li><li>four</li></ol><ul><li>a</li><li><strong>b</strong></li></ul>',
      text: '3. three\n4. four\n\n- a\n- b'
    });
    const valued = el('ol', {}, el('li', { value: '2' }, 'two'), el('li', { value: '5' }, 'five'));
    expect(copyOf([valued])).toEqual({ html: '<ol><li value="2">two</li><li value="5">five</li></ol>', text: '2. two\n5. five' });
  });

  test('a list number that is not a plain count is never written out', () => {
    expect(copyOf([el('ol', { start: '1" onload="x' }, el('li', { value: '-2' }, 'a'))]).html).toBe('<ol><li>a</li></ol>');
  });

  test('the formatting a partial selection sits in comes along: a few words of a bold run stay bold', () => {
    expect(copyOf(['ken Sto'], [el('strong', {})])).toEqual({ html: '<p><strong>ken Sto</strong></p>', text: 'ken Sto' });
    expect(copyOf([el('li', {}, 'ree'), el('li', {}, 'fo')], [el('ol', { start: '3' })])).toEqual({ html: '<ol start="3"><li>ree</li><li>fo</li></ol>', text: '3. ree\n4. fo' });
  });

  test("your question keeps its line breaks; an answer's soft breaks read as spaces", () => {
    expect(copyOf([el('p', { 'data-copy-pre': '' }, 'first line\nsecond  line')])).toEqual({ html: '<p>first line<br>second  line</p>', text: 'first line\nsecond  line' });
    expect(copyOf([p('one\n  two')])).toEqual({ html: '<p>one two</p>', text: 'one two' });
    expect(copyOf([p('a', el('br'), 'b')])).toEqual({ html: '<p>a<br>b</p>', text: 'a\nb' });
  });

  test('headings paste as bold paragraphs (no Word heading styles)', () => {
    expect(copyOf([el('h4', {}, 'Your requests'), p('x')])).toEqual({ html: '<p><strong>Your requests</strong></p><p>x</p>', text: 'Your requests\n\nx' });
  });

  test('a prefix comes before a part that has text, never before an empty one', () => {
    const point = (time: string) => el('li', {},
      el('span', { role: 'img', 'data-copy-text': '✓ ' }),
      el('span', {}, 'Keep tokens'),
      el('span', { 'data-copy-before': ' · ' }, time),
      el('span', { 'data-copy-before': ' — ' }));
    expect(copyOf([el('ol', {}, point('12:41'), point(''))])).toEqual({ html: '<ol><li>✓ Keep tokens · 12:41</li><li>✓ Keep tokens</li></ol>', text: '1. ✓ Keep tokens · 12:41\n2. ✓ Keep tokens' });
  });

  test('a verdict: its state word in bold, then its label', () => {
    const verdict = el('p', {}, el('span', { 'data-copy-wrap': 'strong' }, 'Done: '), el('span', { 'aria-hidden': 'true' }), el('span', {}, 'All ', el('code', {}, '4/4')));
    expect(copyOf([verdict])).toEqual({ html: '<p><strong>Done:</strong> All <code>4/4</code></p>', text: 'Done: All 4/4' });
  });

  test('blocks apart: text loose in a container is a paragraph of its own', () => {
    expect(copyOf([el('div', {}, 'loose ', el('em', {}, 'text'), el('div', {}, p('inner')), 'after')])).toEqual({ html: '<p>loose <em>text</em></p><p>inner</p><p>after</p>', text: 'loose text\n\ninner\n\nafter' });
  });

  test('a link copies as a link to its URL; its text names the URL after a label that differs from it', () => {
    const U = 'https://tasks.acme-store.test/t/86c0f15?a=1&b=2';
    const a = (href: string, ...kids: CopyNode[]) => el('a', { href }, ...kids, el('span', { 'aria-hidden': 'true' }, '↗'));
    expect(copyOf([p('See ', a(U, 'the ', el('strong', {}, 'F15'), ' task'), '.')])).toEqual({
      html: '<p>See <a href="https://tasks.acme-store.test/t/86c0f15?a=1&amp;b=2">the <strong>F15</strong> task</a>.</p>',
      text: `See the F15 task (${U}).`
    });
    expect(copyOf([p(a(U, U))])).toEqual({ html: `<p><a href="${U.replace('&', '&amp;')}">${U.replace('&', '&amp;')}</a></p>`, text: U });
  });

  test('two links side by side stay two; a few words of a link keep it; a link to anything but http(s) is its text', () => {
    const one = 'https://acme-store.test/1', two = 'https://acme-store.test/2';
    expect(copyOf([p(el('a', { href: one }, 'one'), el('a', { href: two }, 'two'))]).html).toBe(`<p><a href="${one}">one</a><a href="${two}">two</a></p>`);
    expect(copyOf(['F1'], [el('p'), el('a', { href: one })])).toEqual({ html: `<p><a href="${one}">F1</a></p>`, text: `F1 (${one})` });
    expect(copyOf([p(el('a', { href: 'javascript:alert(1)' }, 'x'))])).toEqual({ html: '<p>x</p>', text: 'x' });
    // An href is written as the browser reads it, never as spelled (control characters, case).
    expect(copyOf([p(el('a', { href: '\u0001HTTPS://ACME-STORE.TEST/a' }, 'x'))]).html).toBe('<p><a href="https://acme-store.test/a">x</a></p>');
  });

  test('HTML in the text is text', () => {
    expect(copyOf([p('<script>alert("x")</script> & co')]).html).toBe('<p>&lt;script&gt;alert("x")&lt;/script&gt; &amp; co</p>');
  });

  test('nothing selectable: nothing to copy', () => {
    expect(copyOf([el('header', { 'data-copy': 'skip' }, 'x'), '   '])).toEqual({ html: '', text: '' });
  });
});

describe('answerCopy (Copy under an answer)', () => {
  test("the answer's Markdown as text, its blocks as clean HTML: verdict, paragraph, steps, bullets, a Detail box (open or not)", () => {
    const md = 'Verdict: in-progress — Auth refactor `3/4`\n\nThe **refresh** reads `src/auth/session.ts:58`.\n\n1. Keep tokens\n2. Test it\n\n- *a*\n\n:::detail Why 30 s\nClock skew.\n:::\n';
    expect(answerCopy(md)).toEqual({
      text: md,
      html: '<p><strong>In progress:</strong> Auth refactor <code>3/4</code></p><p>The <strong>refresh</strong> reads <code>src/auth/session.ts:58</code>.</p>'
        + '<ol><li>Keep tokens</li><li>Test it</li></ol><ul><li><em>a</em></li></ul><p><strong>Why 30 s</strong></p><p>Clock skew.</p>'
    });
  });

  test('HTML the model wrote stays text', () => {
    expect(answerCopy('<b>x</b>').html).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  test('links: a link to the URL the panel opens, with its label as written (bold kept), in lists and Detail boxes too', () => {
    const U = 'https://tasks.acme-store.test/t/86c0f15';
    const md = `See [the **F15** task](${U}).\n\n- **[F11](https://acme-store.test/t/1)**, then https://acme-store.test/t/2.\n\n:::detail Where\n<${U}>\n:::\n`;
    expect(answerCopy(md)).toEqual({
      text: md,
      html: `<p>See <a href="${U}">the <strong>F15</strong> task</a>.</p>`
        + '<ul><li><a href="https://acme-store.test/t/1"><strong>F11</strong></a>, then <a href="https://acme-store.test/t/2">https://acme-store.test/t/2</a>.</li></ul>'
        + `<p><strong>Where</strong></p><p><a href="${U}">${U}</a></p>`
    });
  });
});

describe('threadCopy (Copy Thread)', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 31, h, m).getTime();
  const items: ThreadItem[] = [
    { kind: 'catchup', id: 'c1', at: at(12, 40), model: 'sonnet', read: [], final: false, data: {
      points: [{ n: 1, text: 'Keep `TokenStore`', status: 'done', at: '12:31', note: null }, { n: 2, text: 'Tests', status: 'in_progress', at: null, note: '1 of 3 left' }, { n: 3, text: 'Cookies', status: 'not_started', at: null, note: null }],
      where: 'Re-running the tests.', choices: ['Skew window 30 s'], leftOpen: null
    } },
    { kind: 'question', id: 'q1', at: at(12, 41), text: 'Why 30 s?\nReally?' },
    { kind: 'answer', id: 'a1', at: at(12, 42), questionId: 'q1', markdown: 'Clock **skew**.', read: [], model: 'sonnet', costUsd: null },
    { kind: 'error', id: 'e1', at: at(12, 43), questionId: null, reason: 'timeout', message: 'Took too long <again>' }
  ];
  const thread: Thread = { ...newThread('s1', '11111111-1111-4111-8111-111111111111', 0), items };

  test('the text is Copy Thread as Markdown, unchanged', () => {
    expect(threadCopy(thread, 'auth-refactor').text).toBe(threadMarkdown(thread, 'auth-refactor'));
  });

  test("the HTML: the session's name, then each item under a bold header line, the card as the panel shows it", () => {
    expect(threadCopy(thread, 'auth <refactor>').html).toBe(
      '<p><strong>Ask about auth &lt;refactor&gt;</strong></p>'
      + '<p><strong>Catch me up · 12:40</strong></p>'
      + '<p><strong>Your requests</strong></p><ol><li value="1">✓ Keep <code>TokenStore</code> · 12:31</li><li value="2">◐ Tests · now — 1 of 3 left</li><li value="3">○ Cookies · next</li></ol>'
      + '<p><strong>Where it is</strong></p><p>Re-running the tests.</p>'
      + '<p><strong>Choices it made</strong></p><ul><li>Skew window 30 s</li></ul>'
      + '<p><strong>You · 12:41</strong></p><p>Why 30 s?<br>Really?</p>'
      + '<p><strong>Ask · Sonnet · 12:42</strong></p><p>Clock <strong>skew</strong>.</p>'
      + '<p><strong>Error · 12:43</strong></p><p>Took too long &lt;again&gt;</p>'
    );
  });

  test("a point's number that is not a plain count is never written out", () => {
    const odd: Thread = { ...thread, items: [{ kind: 'catchup', id: 'c', at: at(13, 2), model: 'opus', read: [], final: false, data: { points: [{ n: -2, text: 'A', status: 'unclear', at: null, note: null }, { n: 1e21, text: 'B', status: 'unclear', at: null, note: null }], where: '', choices: [], leftOpen: null } }] };
    expect(threadCopy(odd, 'a').html).toContain('<ol><li>? A</li><li>? B</li></ol>');
  });

  test('a final card says so and shows what was left open', () => {
    const final: Thread = { ...thread, items: [{ kind: 'catchup', id: 'c', at: at(13, 2), model: 'opus', read: [], final: true, data: { points: [{ n: 1, text: 'Tests', status: 'in_progress', at: null, note: null }], where: 'x', choices: [], leftOpen: 'The **cookie** path.' } }] };
    expect(threadCopy(final, 'a').html).toBe('<p><strong>Ask about a</strong></p><p><strong>Catch me up (final) · 13:02</strong></p>'
      + '<p><strong>Your requests</strong></p><ol><li value="1">◐ Tests · not done</li></ol><p><strong>Left open</strong></p><p>The <strong>cookie</strong> path.</p>');
  });
});
