import { describe, expect, it } from 'vitest';
import { parseAnswer, type AnswerBlock, type Inline } from './answer';

const para = (md: string): Inline[] => {
  const b = parseAnswer(md)[0];
  if (b?.k !== 'para') throw new Error('not a para');
  return b.inline;
};

describe('verdict', () => {
  it('parses the first line with state, label and progress', () => {
    expect(parseAnswer('Verdict: in-progress — Not yet · 2/3 tests fixed\n\nText')[0]).toEqual({ k: 'verdict', state: 'in-progress', label: 'Not yet · 2/3 tests fixed', progress: { n: 2, m: 3 } });
  });
  it('accepts en dash and hyphen, and no progress', () => {
    expect(parseAnswer('Verdict: done – All good')[0]).toEqual({ k: 'verdict', state: 'done', label: 'All good', progress: null });
    expect(parseAnswer('Verdict: unclear - Cannot tell')[0]).toMatchObject({ state: 'unclear', label: 'Cannot tell' });
  });
  it('is plain text when not first or with an unknown state', () => {
    expect(parseAnswer('Hi\n\nVerdict: done — ok').every((b) => b.k !== 'verdict')).toBe(true);
    expect(parseAnswer('Verdict: great — ok')[0]?.k).toBe('para');
  });
});

describe('detail blocks', () => {
  it('parses a closed block', () => {
    const b = parseAnswer(':::detail Why one refresh\nBody **b**\n:::');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ k: 'detail', title: 'Why one refresh' });
    const d = b[0] as Extract<AnswerBlock, { k: 'detail' }>;
    expect(d.body[0]).toEqual({ k: 'para', inline: [{ t: 'text', s: 'Body ' }, { t: 'bold', s: 'b' }] });
  });
  it('treats an unclosed block as plain paragraphs', () => {
    const b = parseAnswer(':::detail T\nrest');
    expect(b.every((x) => x.k !== 'detail')).toBe(true);
    expect(b.length).toBeGreaterThan(0);
  });
  it('does not nest', () => {
    const b = parseAnswer(':::detail A\n:::detail B\nx\n:::');
    const d = b[0] as Extract<AnswerBlock, { k: 'detail' }>;
    expect(d.k).toBe('detail');
    expect(d.body.some((x) => x.k === 'detail')).toBe(false);
  });
});

describe('file references', () => {
  it('reads path:line and ranges', () => {
    expect(para('`src/auth/token-store.ts:58`')).toEqual([{ t: 'file', path: 'src/auth/token-store.ts', from: 58, to: null, raw: 'src/auth/token-store.ts:58' }]);
    expect(para('`a.ts:41–77`')[0]).toMatchObject({ t: 'file', path: 'a.ts', from: 41, to: 77 });
    expect(para('`a.ts:41-77`')[0]).toMatchObject({ t: 'file', path: 'a.ts', from: 41, to: 77 });
    expect(para('`src/a.ts`')[0]).toMatchObject({ t: 'file', from: null, to: null });
  });
  it('keeps everything else as code', () => {
    for (const c of ['npm test', '../x.ts', '/etc/hosts', 'src/', '~/x.ts', 'a/../b.ts', 'a.ts:0', 'a.ts:9-3', 'foo']) {
      expect(para('`' + c + '`')).toEqual([{ t: 'code', s: c }]);
    }
  });
  // Windows: the model writes project paths both ways there.
  it('a relative reference written with backslashes is the same project path, with forward slashes (raw as written)', () => {
    expect(para('`src\\auth\\session.ts:12`')).toEqual([{ t: 'file', path: 'src/auth/session.ts', from: 12, to: null, raw: 'src\\auth\\session.ts:12' }]);
    expect(para('`src\\a.ts:41–77`')[0]).toMatchObject({ t: 'file', path: 'src/a.ts', from: 41, to: 77 });
    expect(para('`src/auth\\session.ts`')[0]).toMatchObject({ t: 'file', path: 'src/auth/session.ts', from: null });
  });
  it('drive-absolute, UNC, rooted and escaping references stay code, as a posix absolute one does', () => {
    for (const c of ['C:\\dev\\spike-ask\\proj [v2] (1)\\src\\auth\\session.ts', 'C:\\dev\\app\\src\\a.ts:12', 'C:/dev/app/src/a.ts', 'c:src\\a.ts',
      '\\\\server\\share\\a.ts', '\\src\\a.ts', '..\\x.ts', 'src\\..\\..\\x.ts', 'src\\', 'src\\\\a.ts'])
      expect(para('`' + c + '`'), c).toEqual([{ t: 'code', s: c }]);
  });
});

describe('inline and blocks', () => {
  it('reads bold, italic and code', () => {
    expect(para('**b** *i* _j_ `c`').map((x) => x.t)).toEqual(['bold', 'text', 'italic', 'text', 'italic', 'text', 'code']);
  });
  it('leaves unmatched markers literal', () => {
    expect(para('a ** b')).toEqual([{ t: 'text', s: 'a ** b' }]);
    expect(para('snake_case_name')).toEqual([{ t: 'text', s: 'snake_case_name' }]);
  });
  it('keeps HTML as text', () => {
    expect(para('<b>x</b>')).toEqual([{ t: 'text', s: '<b>x</b>' }]);
  });
  it('splits paragraphs and reads lists', () => {
    expect(parseAnswer('a\n\nb')).toHaveLength(2);
    const l = parseAnswer('- one\n* two')[0];
    expect(l).toMatchObject({ k: 'list', ordered: false });
    expect((l as Extract<AnswerBlock, { k: 'list' }>).items).toHaveLength(2);
    expect(parseAnswer('1. a\n2. b')[0]).toMatchObject({ k: 'list', ordered: true });
  });
  it('caps the input and never throws', () => {
    const big = 'x'.repeat(200_000);
    const b = parseAnswer(big);
    expect(JSON.stringify(b).length).toBeLessThan(70_000);
    expect(() => parseAnswer('\u0000:::detail\n`\n**')).not.toThrow();
    expect(parseAnswer('')).toEqual([]);
  });
});

describe('links', () => {
  const U = 'https://tasks.acme-store.test/t/86c0f15';
  const link = (url: string, ...label: Inline[]): Inline => ({ t: 'link', url, label: label as never });
  const text = (s: string): Inline => ({ t: 'text', s });

  it('reads a Markdown link to an http(s) URL; its label keeps its own formatting', () => {
    expect(para(`See [the **F15** task](${U}).`)).toEqual([text('See '), link(U, text('the '), { t: 'bold', s: 'F15' }, text(' task')), text('.')]);
    expect(para('[docs](http://acme-store.test/a?b=1#c)')).toEqual([link('http://acme-store.test/a?b=1#c', text('docs'))]);
  });

  it('reads a bare http(s) URL and an autolink, without the punctuation that ends the sentence', () => {
    expect(para(`Open ${U}. Or (${U}), then ${U}?`)).toEqual([
      text('Open '), link(U, text(U)), text('. Or ('), link(U, text(U)), text('), then '), link(U, text(U)), text('?')
    ]);
    expect(para(`Here: <${U}>`)).toEqual([text('Here: '), link(U, text(U))]);
    expect(para('Then [x] HTTPS://ACME-STORE.TEST/A')).toEqual([text('Then [x] '), link('https://acme-store.test/A', text('HTTPS://ACME-STORE.TEST/A'))]);
  });

  it('keeps balanced parentheses in a URL', () => {
    const w = 'https://wiki.acme-store.test/Token_(auth)';
    expect(para(`[w](${w}) and ${w}.`)).toEqual([link(w, text('w')), text(' and '), link(w, text(w)), text('.')]);
  });

  it('opens the URL as the browser reads it (the target the tooltip shows), never the raw spelling', () => {
    expect(para('[a](https://Acme-Store.TEST/x)')).toEqual([link('https://acme-store.test/x', text('a'))]);
    // A look-alike host (a Cyrillic "а") shows as what it is.
    expect(para('[a](https://аcme.test/)')).toEqual([link('https://xn--cme-5cd.test/', text('a'))]);
  });

  it('a URL longer than a browser would take is text, never a link to a part of it', () => {
    const long = `https://acme-store.test/${'x'.repeat(3000)}`;
    expect(para(long)).toEqual([text(long)]);
    expect(para(`[a](${long})`)).toEqual([text(`[a](${long})`)]);
  });

  it('leaves every other link as text: no scheme, other schemes, relative paths, spaces', () => {
    for (const md of [
      '[x](javascript:alert(1))', '[x](tasks.acme-store.test/t/1)', '[x](src/a.ts)', '[x](file:///etc/hosts)',
      '[x](mailto:dev@acme-store.test)', '[x](https:// y)', 'javascript://x', 'ftp://acme-store.test/a', 'https://', '[x](https://)'
    ]) expect(para(md), md).toEqual([text(md)]);
  });

  it('a URL inside a word or in code stays as written; a label holds no link and no file chip', () => {
    expect(para('xhttps://acme-store.test/a')).toEqual([text('xhttps://acme-store.test/a')]);
    expect(para(`\`${U}\``)).toEqual([{ t: 'code', s: U }]);
    expect(para(`[see \`src/a.ts:2\` at https://tasks.acme-store.test](${U})`)).toEqual([link(U, text('see '), { t: 'code', s: 'src/a.ts:2' }, text(' at https://tasks.acme-store.test'))]);
  });

  it('a link in bold or italic is a link whose label is bold or italic', () => {
    expect(para(`**Created: [F15](${U}), today**`)).toEqual([{ t: 'bold', s: 'Created: ' }, link(U, { t: 'bold', s: 'F15' }), { t: 'bold', s: ', today' }]);
    expect(para(`*${U}*`)).toEqual([link(U, { t: 'italic', s: U })]);
  });

  it('a label never names another site than the link opens: the link then shows its URL', () => {
    const evil = 'https://evil.test/x';
    for (const label of ['https://github.com/acme/repo/pull/1', 'github.com/acme/repo', 'see www.acme-store.test', 'README.md']) {
      expect(para(`[${label}](${evil})`), label).toEqual([link(evil, text(evil))]);
    }
    // The host it names is the target's, or a part of it: the label stays.
    expect(para('[docs.acme-store.test](https://docs.acme-store.test/a)')).toEqual([link('https://docs.acme-store.test/a', text('docs.acme-store.test'))]);
    expect(para('[acme-store.test](https://www.acme-store.test/)')).toEqual([link('https://www.acme-store.test/', text('acme-store.test'))]);
    expect(para('[the **acme-store.test** docs](https://acme-store.test/)')).toEqual([link('https://acme-store.test/', text('the '), { t: 'bold', s: 'acme-store.test' }, text(' docs'))]);
  });

  it('a URL whose written host is not the host it opens is text: credentials before it, an encoded host', () => {
    for (const md of [
      'https://github.com@evil.test/login', '<https://github.com@evil.test/login>', '[a](https://github.com@evil.test/login)',
      'https://u:p@acme-store.test/', 'https://good.test%2eevil.test/', '[a](https://good.test%2eevil.test/)'
    ]) expect(para(md), md).toEqual([text(md)]);
  });

  it('invisible and direction marks are never part of a URL', () => {
    expect(para('https://acme-store.test/‮gnp.exe')).toEqual([link('https://acme-store.test/', text('https://acme-store.test/')), text('‮gnp.exe')]);
    expect(para('[a](https://acme-store.test/​x)')).toEqual([text('[a](https://acme-store.test/​x)')]);
  });

  it('a bare URL ends where the ASCII does: text written right after it, full-width punctuation', () => {
    expect(para('詳細はhttps://acme-store.test/docsを参照。')).toEqual([text('詳細は'), link('https://acme-store.test/docs', text('https://acme-store.test/docs')), text('を参照。')]);
    expect(para('（https://acme-store.test/a）')).toEqual([text('（'), link('https://acme-store.test/a', text('https://acme-store.test/a')), text('）')]);
  });

  it('a URL that grows past what the app opens once encoded is text', () => {
    const md = `[a](https://acme-store.test/${'é'.repeat(1000)})`;
    expect(para(md)).toEqual([text(md)]);
  });

  it('a Markdown link it does not read stays text whole, never with a live link inside (a title, an unfinished one while streaming)', () => {
    for (const md of ['[a](https://acme-store.test "t")', 'Created [the export case](https://tasks.acme-store.test/t/86c']) {
      expect(para(md), md).toEqual([text(md)]);
    }
  });

  it('code binds tighter than links: a code span stays code, in bold too and across a label', () => {
    expect(para('**Run `curl https://api.acme-store.test/v1`** now')).toEqual([{ t: 'bold', s: 'Run `curl https://api.acme-store.test/v1`' }, text(' now')]);
    expect(para('[a `b](https://acme-store.test)` c')).toEqual([text('[a '), { t: 'code', s: 'b](https://acme-store.test)' }, text(' c')]);
  });

  it('a label with nothing visible shows the URL', () => {
    for (const label of ['', ' ', '​', '** **']) expect(para(`[${label}](https://acme-store.test/x)`), JSON.stringify(label)).toEqual([link('https://acme-store.test/x', text('https://acme-store.test/x'))]);
  });

  it('a list item and a Detail body read links too', () => {
    expect(parseAnswer(`- [F15](${U})`)[0]).toEqual({ k: 'list', ordered: false, items: [[link(U, text('F15'))]] });
    expect(parseAnswer(`:::detail Links\n${U}\n:::`)[0]).toEqual({ k: 'detail', title: 'Links', body: [{ k: 'para', inline: [link(U, text(U))] }] });
  });
});

describe('linear time on adversarial input', () => {
  const MAX = 64 * 1024;
  const timed = (md: string): number => { const t0 = performance.now(); parseAnswer(md); return performance.now() - t0; };
  it.each([
    ['star openers', '*a '.repeat(MAX / 3)],
    ['underscore openers', '_a '.repeat(MAX / 3)],
    ['verdict trailing spaces', 'Verdict: done - a' + ' '.repeat(MAX) + 'x'],
    ['verdict digit label', 'Verdict: done - ' + '1'.repeat(MAX)],
    ['unclosed details', ':::detail x\n'.repeat(MAX / 12)],
    ['backticks', '`a '.repeat(MAX / 3)],
    ['mixed', ('*a _b `c **d :::detail\n- ').repeat(MAX / 24)],
    ['link openers', '[a]('.repeat(MAX / 4)],
    ['link openers with long URLs', ('[a](https://' + 'x'.repeat(3000)).repeat(MAX / 3012)],
    ['bare URLs that never parse', 'https://[:'.repeat(MAX / 10)],
    ['long bare URLs', ('https://a.test/' + 'x'.repeat(3000) + ' ').repeat(MAX / 3016)],
    ['brackets', '['.repeat(MAX)],
    ['bold links', ('**[a](https://b.test/' + 'c'.repeat(100)).repeat(MAX / 120)],
    ['URLs ending in closing parentheses', ('https://a' + ')'.repeat(2040) + ' ').repeat(32)],
    ['URLs ending in closing parentheses and stops', ('https://a' + ').'.repeat(1020) + ' ').repeat(32)],
    ['bold URLs ending in closing parentheses', ('**https://a' + ')'.repeat(2030) + '** ').repeat(32)],
    ['labels naming hosts', ('[' + 'a.bc '.repeat(59) + '](https://d.test/) ').repeat(MAX / 320)],
  ])('%s parses in under 200 ms', (_n, md) => {
    expect(timed(md)).toBeLessThan(200);
  });
});

describe('verdict progress bounds and list follow-ups', () => {
  it('has no progress for 0/0 or n > m', () => {
    expect(parseAnswer('Verdict: done — 0/0 x')[0]).toMatchObject({ progress: null });
    expect(parseAnswer('Verdict: done — 5/3 x')[0]).toMatchObject({ progress: null });
    expect(parseAnswer('Verdict: done — 3/3 x')[0]).toMatchObject({ progress: { n: 3, m: 3 } });
  });
  it('turns an indented follow-up line after a list item into a paragraph', () => {
    const b = parseAnswer('- one\n  more');
    expect(b.map((x) => x.k)).toEqual(['list', 'para']);
  });
});
