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
  it('keeps HTML and links as text', () => {
    expect(para('<b>x</b>')).toEqual([{ t: 'text', s: '<b>x</b>' }]);
    expect(para('[x](http://y)')).toEqual([{ t: 'text', s: '[x](http://y)' }]);
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
