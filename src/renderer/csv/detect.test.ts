import { describe, expect, test } from 'vitest';
import { detect, resolve } from './detect';
import { AUTO_OPTIONS } from './types';

const ORDERS_SEMI = [
  'order_id;created_at;customer;country;status;items;total_eur;paid',
  'A-10231;2026-07-01 09:14;Bottega Rossi;IT;delivered;3;284,50;true',
  'A-10232;2026-07-01 11:02;Nordlicht GmbH;DE;delivered;12;1284,00;true',
  'A-10233;2026-07-02 16:40;"Atelier; Lumière";FR;shipped;5;612,90;true'
].join('\n');

describe('detect: delimiter', () => {
  test('each delimiter', () => {
    expect(detect('a,b,c\n1,2,3\n4,5,6', 'csv').delimiter).toBe(',');
    expect(detect('a;b;c\n1;2;3\n4;5;6', 'csv').delimiter).toBe(';');
    expect(detect('a\tb\tc\n1\t2\t3', 'csv').delimiter).toBe('\t');
    expect(detect('a|b|c\n1|2|3', 'csv').delimiter).toBe('|');
  });

  test('a semicolon file with decimal commas: the consistent one with more fields', () => {
    expect(detect(ORDERS_SEMI, 'csv').delimiter).toBe(';');
  });

  test('delimiters inside quotes do not count', () => {
    expect(detect('name,note\n"a;b;c",x\n"d;e;f",y\n"g;h;i",z', 'csv').delimiter).toBe(',');
  });

  test('a tie in consistency: more fields win', () => {
    // Commas: 2 fields everywhere; semicolons: 3 fields everywhere.
    expect(detect('a,b;c;d\n1,2;3;4\n5,6;7;8', 'csv').delimiter).toBe(';');
  });

  test('more consistent beats more fields', () => {
    // Commas: 2 fields on every line; semicolons: 4 fields on three lines of four.
    expect(detect('a;b;c;d,e\n1;2;3;4,5\n6;7;8;9,0\nx,y', 'csv').delimiter).toBe(',');
  });

  test('a single column: comma (or Tab for .tsv)', () => {
    expect(detect('name\nAda\nLinus', 'csv').delimiter).toBe(',');
    expect(detect('name\nAda\nLinus', 'tsv').delimiter).toBe('\t');
    expect(detect('', 'csv').delimiter).toBe(',');
  });

  test('.tsv prefers Tab when the text has tabs', () => {
    expect(detect('a\tb,c\n1\t2,3', 'tsv').delimiter).toBe('\t');
  });

  test('a BOM and blank lines do not confuse it', () => {
    expect(detect('﻿a;b\n\n1;2\n\n3;4\n', 'csv').delimiter).toBe(';');
  });
});

describe('detect: header', () => {
  test('names over data', () => {
    expect(detect('id,name,score\n1,Ada,9.5\n2,Linus,7', 'csv').header).toBe(true);
    expect(detect(ORDERS_SEMI, 'csv').header).toBe(true);
  });

  test('a first row of data: a number in a numeric column, a date in a date column', () => {
    expect(detect('1,Ada,9.5\n2,Linus,7\n3,Grace,8', 'csv').header).toBe(false);
    expect(detect('2026-07-01,a\n2026-07-02,b', 'csv').header).toBe(false);
  });

  test('a single row, or no rows: header', () => {
    expect(detect('1,2,3', 'csv').header).toBe(true);
    expect(detect('', 'csv').header).toBe(true);
  });

  test('all-text columns: header', () => {
    expect(detect('Ada,London\nLinus,Helsinki', 'csv').header).toBe(true);
  });
});

describe('detect: decimal separator', () => {
  test('comma decimals in a semicolon file', () => {
    expect(detect(ORDERS_SEMI, 'csv').decimal).toBe(',');
    expect(detect('a;b\nx;1.284,50\ny;2,5', 'csv').decimal).toBe(',');
  });

  test('dot decimals, or both kinds: dot', () => {
    expect(detect('a;b\nx;1.5\ny;2.25', 'csv').decimal).toBe('.');
    expect(detect('a;b\nx;1,5\ny;2.25', 'csv').decimal).toBe('.');
  });

  test('a comma-delimited file is always dot', () => {
    expect(detect('a,b\nx,"1,5"', 'csv').decimal).toBe('.');
  });

  test('grouped integers with dots are not dot decimals', () => {
    expect(detect('a;b\nx;1.284\ny;2,5', 'csv').decimal).toBe(',');
  });
});

describe('resolve', () => {
  test('auto takes what was found, choices win', () => {
    const d = { delimiter: ';' as const, header: false, decimal: ',' as const };
    expect(resolve(AUTO_OPTIONS, d)).toEqual({ delimiter: ';', header: false, decimal: ',', skip: 0 });
    expect(resolve({ delimiter: '\t', header: true, decimal: '.', skip: 2 }, d)).toEqual({ delimiter: '\t', header: true, decimal: '.', skip: 2 });
  });
});
