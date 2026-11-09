import { describe, expect, test } from 'vitest';
import { parseCsv, splitRecord } from './parse';
import type { Resolved } from './types';

const O: Resolved = { delimiter: ',', header: true, decimal: '.', skip: 0 };
const semi: Resolved = { ...O, delimiter: ';' };

describe('parseCsv', () => {
  test('header, rows and their lines', () => {
    const d = parseCsv('id,name\n1,Ada\n2,Linus\n', O);
    expect(d.header).toEqual(['id', 'name']);
    expect(d.headerLine).toBe(1);
    expect(d.rows).toEqual([['1', 'Ada'], ['2', 'Linus']]);
    expect(d.lines).toEqual([2, 3]);
    expect(d.endLines).toEqual([2, 3]);
    expect(d.width).toBe(2);
    expect(d.expected).toBe(2);
    expect(d.problems).toEqual([]);
  });

  test('without a header every record is data', () => {
    const d = parseCsv('1,Ada\n2,Linus', { ...O, header: false });
    expect(d.header).toBeNull();
    expect(d.headerLine).toBeNull();
    expect(d.rows).toEqual([['1', 'Ada'], ['2', 'Linus']]);
    expect(d.lines).toEqual([1, 2]);
  });

  test('quoted fields: delimiters, escaped quotes, spaces kept', () => {
    const d = parseCsv('a;b;c\n"Hafen & Co; Bremen";"say ""hi""";  x \n', semi);
    expect(d.rows).toEqual([['Hafen & Co; Bremen', 'say "hi"', '  x ']]);
  });

  test('a quoted field spans lines', () => {
    const d = parseCsv('a,b\n1,"two\nlines"\n3,x\n', O);
    expect(d.rows).toEqual([['1', 'two\nlines'], ['3', 'x']]);
    expect(d.lines).toEqual([2, 4]);
    expect(d.endLines).toEqual([3, 4]);
  });

  test('CRLF line ends and a quoted CRLF', () => {
    const d = parseCsv('a,b\r\n1,2\r\n"x\r\ny",3\r\n', O);
    expect(d.rows).toEqual([['1', '2'], ['x\r\ny', '3']]);
    expect(d.lines).toEqual([2, 3]);
    expect(d.endLines).toEqual([2, 4]);
  });

  test('a leading BOM is ignored', () => {
    expect(parseCsv('﻿"id",name\n1,a', O).header).toEqual(['id', 'name']);
  });

  test('blank lines are not rows, but count as lines', () => {
    const d = parseCsv('a,b\n\n1,2\n\n\n3,4\n\n', O);
    expect(d.rows).toEqual([['1', '2'], ['3', '4']]);
    expect(d.lines).toEqual([3, 6]);
  });

  test('empty fields and a row of delimiters', () => {
    const d = parseCsv('a,b,c\n,,\n1,,3', O);
    expect(d.rows).toEqual([['', '', ''], ['1', '', '3']]);
  });

  test('skip lines at the top (non-blank lines)', () => {
    const d = parseCsv('Orders export Q3\n\nid,name\n1,Ada\n', { ...O, skip: 1 });
    expect(d.header).toEqual(['id', 'name']);
    expect(d.headerLine).toBe(3);
    expect(d.rows).toEqual([['1', 'Ada']]);
    expect(d.lines).toEqual([4]);
  });

  test('rows that do not match the header are problems; width covers the extra field', () => {
    const d = parseCsv('a;b;c\n1;2;3\n1;2;3;4\n1;2\n', semi);
    expect(d.expected).toBe(3);
    expect(d.width).toBe(4);
    expect(d.problems).toEqual([
      { kind: 'fields', row: 1, line: 3, count: 4 },
      { kind: 'fields', row: 2, line: 4, count: 2 }
    ]);
  });

  test('without a header the expected count is the most common one', () => {
    const d = parseCsv('1,2,3\n1,2,3\n1,2\n1,2,3', { ...O, header: false });
    expect(d.expected).toBe(3);
    expect(d.problems).toEqual([{ kind: 'fields', row: 2, line: 3, count: 2 }]);
  });

  test('an unclosed quote takes the rest of the file and is a problem', () => {
    const d = parseCsv('a,b\n1,2\n3,"open\n4,5\n', O);
    expect(d.rows).toEqual([['1', '2'], ['3', 'open\n4,5\n']]);
    expect(d.problems).toEqual([{ kind: 'quote', row: 1, line: 3 }]);
  });

  test('text after a closing quote is kept; a quote inside an unquoted field is literal', () => {
    expect(parseCsv('a,b\n"ab"cd,x"y\n', O).rows).toEqual([['abcd', 'x"y']]);
  });

  test('empty text, header only, last record without a newline', () => {
    const e = parseCsv('', O);
    expect(e).toMatchObject({ header: null, rows: [], width: 0, expected: 0, problems: [] });
    const h = parseCsv('a,b\n', O);
    expect(h.header).toEqual(['a', 'b']);
    expect(h.rows).toEqual([]);
    expect(h.expected).toBe(2);
    expect(parseCsv('a\n1', O).rows).toEqual([['1']]);
  });

  test('tabs and pipes', () => {
    expect(parseCsv('a\tb\n1\t"x\ty"', { ...O, delimiter: '\t' }).rows).toEqual([['1', 'x\ty']]);
    expect(parseCsv('a|b\n1|2', { ...O, delimiter: '|' }).rows).toEqual([['1', '2']]);
  });

  test('5 MB in well under the budget', () => {
    const line = 'A-10231,2026-07-01 09:14,"Bottega Rossi, Milano",IT,delivered,3,284.50,true,some notes here\n';
    const text = 'order_id,created_at,customer,country,status,items,total,paid,notes\n' + line.repeat(Math.ceil(5_000_000 / line.length));
    const t0 = performance.now();
    const d = parseCsv(text, O);
    const ms = performance.now() - t0;
    expect(d.rows.length).toBeGreaterThan(50_000);
    expect(d.problems).toEqual([]);
    expect(ms).toBeLessThan(1500);
  });
});

describe('splitRecord', () => {
  test('one record, quotes undone', () => {
    expect(splitRecord('1;"a;b";"say ""x"""', ';')).toEqual(['1', 'a;b', 'say "x"']);
    expect(splitRecord('', ',')).toEqual(['']);
    expect(splitRecord('"multi\nline",2', ',')).toEqual(['multi\nline', '2']);
  });
});
