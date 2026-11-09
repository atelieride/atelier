import { describe, expect, test } from 'vitest';
import { fieldAt, fieldsOf, lineOfRecord, recordOfLine, scanCsv } from './scan';

// Lines: 1 header, 2 row, 3 blank, 4–5 a row with a quoted line break, 6 row, 7 the empty line after the last newline.
const DOC = 'id,note,n\n1,plain,2\n\n2,"two\nlines",3\n3,"a,""b""",4\n';

describe('scanCsv', () => {
  test('lines that start no record: blank ones and the inside of quoted fields', () => {
    const s = scanCsv(DOC, ',');
    expect(s.lines).toBe(7);
    expect(s.nonStart).toEqual([3, 5, 7]);
  });

  test('a quote only opens a field at its start', () => {
    expect(scanCsv('a,b"c\n1,2\n', ',').nonStart).toEqual([3]);
  });

  test('CRLF and a BOM before a quoted field', () => {
    expect(scanCsv('﻿"a\r\nb",1\r\n2,3', ',')).toEqual({ lines: 3, nonStart: [2] });
  });

  test('an unclosed quote: every following line is inside it', () => {
    expect(scanCsv('a,b\n1,"x\n2,3\n4,5', ',').nonStart).toEqual([3, 4]);
  });

  test('records and their lines', () => {
    const s = scanCsv(DOC, ',');
    expect([1, 2, 3, 4, 5, 6, 7].map((l) => recordOfLine(s, l))).toEqual([0, 1, -1, 2, -1, 3, -1]);
    expect([0, 1, 2, 3].map((r) => lineOfRecord(s, r))).toEqual([1, 2, 4, 6]);
    expect(lineOfRecord(s, 4)).toBe(-1);
    expect(lineOfRecord(s, -1)).toBe(-1);
  });

  test('the other delimiters', () => {
    expect(scanCsv('a;"x;\ny";b\n1;2', ';').nonStart).toEqual([2]);
    expect(scanCsv('a\t"x\ny"\n1\t2', '\t').nonStart).toEqual([2]);
  });
});

describe('fieldsOf / fieldAt', () => {
  test('offsets with quotes included, to the record end', () => {
    const from = DOC.indexOf('3,"a');
    const f = fieldsOf(DOC, from, ',');
    expect(f.map((x) => DOC.slice(x.from, x.to))).toEqual(['3', '"a,""b"""', '4']);
  });

  test('a record spanning lines', () => {
    const from = DOC.indexOf('2,"two');
    expect(fieldsOf(DOC, from, ',').map((x) => DOC.slice(x.from, x.to))).toEqual(['2', '"two\nlines"', '3']);
  });

  test('empty fields, an empty record, CRLF, the last record', () => {
    const t = ',,x\r\n\r\nlast';
    expect(fieldsOf(t, 0, ',')).toEqual([{ from: 0, to: 0 }, { from: 1, to: 1 }, { from: 2, to: 3 }]);
    expect(fieldsOf(t, 5, ',')).toEqual([{ from: 5, to: 5 }]);
    expect(fieldsOf(t, 7, ',')).toEqual([{ from: 7, to: 11 }]);
  });

  test('the field under a position: a delimiter belongs to the field before it', () => {
    const from = DOC.indexOf('1,plain');
    const at = (s: string, k = 0) => fieldAt(DOC, from, from + s.length + k, ',');
    expect(at('')).toBe(0);
    expect(at('1')).toBe(0);
    expect(at('1,')).toBe(1);
    expect(at('1,plain')).toBe(1);
    expect(at('1,plain,')).toBe(2);
    expect(fieldAt(DOC, from, from + 500, ',')).toBe(2);
  });

  test('inside a multi-line field', () => {
    const from = DOC.indexOf('2,"two');
    expect(fieldAt(DOC, from, DOC.indexOf('lines'), ',')).toBe(1);
    expect(fieldAt(DOC, from, DOC.indexOf('",3') + 2, ',')).toBe(2);
  });

  test('5 MB scans in well under the budget', () => {
    const line = 'A-10231,2026-07-01 09:14,"Bottega Rossi, Milano",IT,delivered,3,284.50,true,"a ""quoted"" note"\n';
    const text = line.repeat(Math.ceil(5_000_000 / line.length));
    const t0 = performance.now();
    const s = scanCsv(text, ',');
    expect(s.nonStart).toEqual([s.lines]);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

test('skipped title lines are plain text: an unbalanced quote in them opens nothing (review)', () => {
  const text = '"Report Q3\na,b\n1,2\n';
  expect(scanCsv(text, ',').nonStart).not.toEqual([]);
  const s = scanCsv(text, ',', 1);
  expect(s.nonStart).toEqual([4]);
  expect(recordOfLine(s, 3)).toBe(2);
});
