import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CellView } from '@shared/pg-format';
import { Cell, type CellProps } from './Cell';

// A grid cell per formatCell view: what each Postgres type looks like in the grid.

const html = (view: CellView, o: Partial<Omit<CellProps, 'view'>> = {}) => renderToStaticMarkup(createElement(Cell, { view, width: 200, wrap: false, ...o }));

describe('Cell', () => {
  test('NULL, an empty string and whitespace never look alike', () => {
    expect(html({ k: 'null' })).toBe('<span class="dbt-nul">NULL</span>');
    expect(html({ k: 'empty' })).toBe('<span class="dbt-emp">empty</span>');
    expect(html({ k: 'blank', count: 2 })).toBe('<span class="dbt-blank">␣␣<span class="dbt-blank-n">2 spaces</span></span>');
    expect(html({ k: 'blank', count: 1 })).toContain('>1 space<');
    // A long run: a few marks, then the count.
    expect(html({ k: 'blank', count: 12 })).toBe('<span class="dbt-blank">␣␣␣<span class="dbt-blank-n">12 spaces</span></span>');
  });

  test('masked: the dots, nothing of the value', () => {
    expect(html({ k: 'masked' })).toBe('<span class="dbt-mask">••••••••</span>');
  });

  test('numbers: as formatted, negative ones in the error color', () => {
    expect(html({ k: 'num', text: '48,210', neg: false })).toBe('<span class="dbt-num">48,210</span>');
    expect(html({ k: 'num', text: '−12.50', neg: true })).toBe('<span class="dbt-num is-neg">−12.50</span>');
  });

  test('a foreign key\'s value carries the arrow to its table', () => {
    expect(html({ k: 'num', text: '2041', neg: false }, { fk: true })).toMatch(/^<span class="dbt-fkv"><span class="dbt-num">2041<\/span><svg[^>]*>.*<\/svg><\/span>$/);
  });

  test('booleans: a dot and the word, true green, false dim', () => {
    expect(html({ k: 'bool', on: true })).toBe('<span class="dbt-bool is-t"><i></i>true</span>');
    expect(html({ k: 'bool', on: false })).toBe('<span class="dbt-bool is-f"><i></i>false</span>');
  });

  test('times: to the minute, the relative suffix, the whole value with UTC and unix time on hover', () => {
    expect(html({ k: 'time', text: '2026-11-04 18:22', rel: 'yesterday', title: '2026-11-04 18:22:07.413+01 · 2026-11-04 17:22:07.413+00 UTC · unix 1793812927' }))
      .toBe('<span class="dbt-time" data-tip="2026-11-04 18:22:07.413+01 · 2026-11-04 17:22:07.413+00 UTC · unix 1793812927">2026-11-04 18:22<span class="dbt-rel">yesterday</span></span>');
    expect(html({ k: 'time', text: '2026-11-04', rel: null, title: '2026-11-04' })).toBe('<span class="dbt-time" data-tip="2026-11-04">2026-11-04</span>');
  });

  test('uuid: the first 8 characters bright, the middle folded, the last group dim; the whole one on hover', () => {
    expect(html({ k: 'uuid', head: '8f2a91c4', tail: '-5b0e-4c1f-9d2a-31b7c0a4e7d1' }))
      .toBe('<span class="dbt-uu" data-tip="8f2a91c4-5b0e-4c1f-9d2a-31b7c0a4e7d1"><span class="dbt-uu-h">8f2a91c4</span><span class="dbt-uu-t">-…-31b7c0a4e7d1</span></span>');
  });

  test('a uuid has no click of its own (no button, no copy affordance) — the click selects its row, ⌘C copies', () => {
    const out = html({ k: 'uuid', head: '8f2a91c4', tail: '-5b0e-4c1f-9d2a-31b7c0a4e7d1' });
    expect(out).not.toMatch(/<button|role=|tabindex|onclick|data-copy/i);
    expect(out).not.toMatch(/[Cc]lick to copy/);
  });

  test('JSON: the colored one-line preview, nested values folded, read from the text', () => {
    // `value` (formatCell's parse) is never what shows: the text is.
    const out = html({ k: 'json', value: undefined, raw: '{"plan":"pro","seats":12,"sso":true,"limits":{"a":1}}' });
    expect(out).toBe('<span class="dbt-json"><span class="dbt-jp">{</span><span class="dbt-jk">&quot;plan&quot;</span><span class="dbt-jp">: </span>'
      + '<span class="dbt-js">&quot;pro&quot;</span><span class="dbt-jp">, </span><span class="dbt-jk">&quot;seats&quot;</span><span class="dbt-jp">: </span>'
      + '<span class="dbt-jn">12</span><span class="dbt-jp">, </span><span class="dbt-jk">&quot;sso&quot;</span><span class="dbt-jp">: </span><span class="dbt-jl">true</span>'
      + '<span class="dbt-jp">, </span><span class="dbt-jk">&quot;limits&quot;</span><span class="dbt-jp">: </span><span class="dbt-jfo">{…}</span><span class="dbt-jp">}</span></span>');
  });

  test('JSON numbers exactly as Postgres printed them, past 2^53 too', () => {
    const out = html({ k: 'json', value: { n: 12345678901234567000 }, raw: '{"n": 12345678901234567890, "x": 0.1000000000000000000001}' });
    expect(out).toContain('<span class="dbt-jn">12345678901234567890</span>');
    expect(out).toContain('<span class="dbt-jn">0.1000000000000000000001</span>');
  });

  test('JSON that doesn\'t read (a value cut at 64 KB): its text', () => {
    expect(html({ k: 'json', value: undefined, raw: '{"a": [1, 2' })).toBe('<span class="dbt-text">{&quot;a&quot;: [1, 2</span>');
  });

  test('a long text is clipped without splitting a surrogate pair', () => {
    expect(html({ k: 'text', text: '😀'.repeat(300) })).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test('arrays: chips, "+N" for those past the width; NULL items as NULL', () => {
    const items = ['api', 'beta', 'eu', 'gift-wrap', 'priority', 'vip'];
    expect(html({ k: 'array', items }, { width: 180 })).toBe(
      '<span class="dbt-chips"><span class="dbt-ach">api</span><span class="dbt-ach">beta</span><span class="dbt-ach">eu</span><span class="dbt-ach is-more">+3</span></span>'
    );
    expect(html({ k: 'array', items: ['a', null] }, { width: 400 })).toBe('<span class="dbt-chips"><span class="dbt-ach">a</span><span class="dbt-ach is-null">NULL</span></span>');
    expect(html({ k: 'array', items: [] })).toBe('<span class="dbt-chips"><span class="dbt-ach is-more">{}</span></span>');
  });

  test('arrays wrapped (Wrap Cells): every chip, up to a bound', () => {
    const items = Array.from({ length: 80 }, (_, i) => `t${i}`);
    const out = html({ k: 'array', items }, { width: 120, wrap: true });
    expect(out.split('class="dbt-ach"').length - 1).toBe(50);
    expect(out).toContain('<span class="dbt-ach is-more">+30</span>');
  });

  test('enums: a chip tinted by the value\'s place among the values', () => {
    expect(html({ k: 'enum', text: 'paid', tint: 1 })).toBe('<span class="dbt-en t1">paid</span>');
  });

  test('bytea: the hex head, the kind from its magic bytes, the size', () => {
    expect(html({ k: 'bytes', head: '89504e470d0a1a0a', size: 24_576, mime: 'image/png' }))
      .toBe('<span class="dbt-bytes"><span class="dbt-hex">\\x89504e470d0a1a0a…</span><span class="dbt-ach">PNG</span><span class="dbt-size">24 KB</span></span>');
    expect(html({ k: 'bytes', head: '0001', size: 2, mime: null })).toBe('<span class="dbt-bytes"><span class="dbt-hex">\\x0001</span><span class="dbt-size">2 B</span></span>');
  });

  test('ranges: the brackets dim; geometry; text', () => {
    expect(html({ k: 'range', text: '[1,10)' })).toBe('<span class="dbt-range"><span class="dbt-jp">[</span>1,10<span class="dbt-jp">)</span></span>');
    expect(html({ k: 'range', text: 'empty' })).toBe('<span class="dbt-range">empty</span>');
    expect(html({ k: 'geo', text: 'POINT(9.19 45.46)' })).toBe('<span class="dbt-geo">POINT(9.19 45.46)</span>');
    expect(html({ k: 'text', text: 'Gift wrap please' })).toBe('<span class="dbt-text">Gift wrap please</span>');
  });

  test('tsvector: lexeme chips with their positions', () => {
    expect(html({ k: 'lexemes', items: [{ word: 'gift', pos: '3' }, { word: 'wrap', pos: '' }] }, { width: 400 }))
      .toBe('<span class="dbt-chips"><span class="dbt-ach">gift<i>3</i></span><span class="dbt-ach">wrap</span></span>');
  });

  test('a long value renders only what a cell can show (a 64 KB text is never laid out whole)', () => {
    const out = html({ k: 'text', text: 'x'.repeat(65_536) });
    expect(out.length).toBeLessThan(1200);
    expect(html({ k: 'text', text: 'y'.repeat(65_536) }, { wrap: true }).length).toBeLessThan(3000);
  });

  test('a value cut in main (over 64 KB): marked, how much shows on hover — the mark in a box of its own, never clipped', () => {
    expect(html({ k: 'text', text: 'abc' }, { cut: 12 * 1024 * 1024 }))
      .toBe('<span class="dbt-cutbox"><span class="dbt-cutv"><span class="dbt-text">abc</span></span><span class="dbt-cut" data-tip="Showing 64 KB of 12 MB">…</span></span>');
    // A long one (64 KB of text, of JSON): the value gives way, the mark stays — wrapped too.
    for (const wrap of [false, true]) {
      const long = html({ k: 'text', text: 'x'.repeat(65_536) }, { cut: 200_000, wrap });
      expect(long).toMatch(/^<span class="dbt-cutbox"><span class="dbt-cutv"><span class="dbt-text">x+…<\/span><\/span><span class="dbt-cut" data-tip="Showing 64 KB of 195 KB">…<\/span><\/span>$/);
    }
    expect(html({ k: 'json', value: undefined, raw: `{"a": "${'y'.repeat(70_000)}` }, { cut: 200_000 }))
      .toMatch(/^<span class="dbt-cutbox"><span class="dbt-cutv"><span class="dbt-text">\{&quot;a&quot;: &quot;y+…<\/span><\/span><span class="dbt-cut"/);
  });
});
