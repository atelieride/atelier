import { describe, expect, test } from 'vitest';
import { copyCells, sample, type CopyBlock } from './copy';

const BLOCK: CopyBlock = {
  names: ['customer', 'items', 'total_eur', 'paid'],
  types: ['text', 'integer', 'decimal', 'boolean'],
  rows: [
    ['Atelier Lumière', '5', '612,90', 'true'],
    ['Hafen; "& Co"', '1', '', 'false'],
    ['two\nlines', '12', '1.284,50', 'yes']
  ]
};
const IT = { header: true, delimiter: ';' as const, decimal: ',' as const };

describe('TSV', () => {
  test('tabs between cells, a header row, quotes only where needed', () => {
    expect(copyCells('tsv', BLOCK, IT)).toBe([
      'customer\titems\ttotal_eur\tpaid',
      'Atelier Lumière\t5\t612,90\ttrue',
      'Hafen; "& Co"\t1\t\tfalse',
      '"two\nlines"\t12\t1.284,50\tyes'
    ].join('\n'));
  });
  test('without the header; a tab or a quote in a field is quoted', () => {
    const b: CopyBlock = { names: ['a'], types: ['text'], rows: [['x\ty'], ['"q" start']] };
    expect(copyCells('tsv', b, { ...IT, header: false })).toBe('"x\ty"\n"""q"" start"');
  });
});

test('Markdown of a selection of 200 000 rows: copied (the column widths never spread one argument per row)', () => {
  const b: CopyBlock = { names: ['id'], types: ['text'], rows: Array.from({ length: 200_000 }, (_, i) => [`r${i}`]) };
  const md = copyCells('markdown', b, IT).split('\n');
  expect(md).toHaveLength(200_002);
  expect(md[2]).toBe('| r0      |');
});

describe('CSV', () => {
  test('the file’s delimiter, RFC 4180 quoting', () => {
    expect(copyCells('csv', BLOCK, IT)).toBe([
      'customer;items;total_eur;paid',
      'Atelier Lumière;5;612,90;true',
      '"Hafen; ""& Co""";1;;false',
      '"two\nlines";12;1.284,50;yes'
    ].join('\n'));
  });
  test('comma delimiter quotes commas', () => {
    const b: CopyBlock = { names: ['n'], types: ['decimal'], rows: [['1,5']] };
    expect(copyCells('csv', b, { header: false, delimiter: ',', decimal: ',' })).toBe('"1,5"');
  });
});

describe('Markdown', () => {
  test('a padded table, numeric columns right-aligned, pipes escaped, newlines as <br>', () => {
    expect(copyCells('markdown', BLOCK, IT)).toBe([
      '| customer        | items | total_eur | paid  |',
      '| --------------- | ----: | --------: | ----- |',
      '| Atelier Lumière |     5 |    612,90 | true  |',
      '| Hafen; "& Co"   |     1 |           | false |',
      '| two<br>lines    |    12 |  1.284,50 | yes   |'
    ].join('\n'));
    const b: CopyBlock = { names: ['a|b'], types: ['text'], rows: [['x|y']] };
    expect(copyCells('markdown', b, IT)).toBe('| a\\|b |\n| ---- |\n| x\\|y |');
  });
  test('always has its header row (Markdown tables need one)', () => {
    expect(copyCells('markdown', BLOCK, { ...IT, header: false }).split('\n')[0]).toBe('| customer        | items | total_eur | paid  |');
  });
});

describe('JSON', () => {
  test('an array of objects with typed values; empty numbers null, empty text ""', () => {
    expect(JSON.parse(copyCells('json', BLOCK, IT))).toEqual([
      { customer: 'Atelier Lumière', items: 5, total_eur: 612.9, paid: true },
      { customer: 'Hafen; "& Co"', items: 1, total_eur: null, paid: false },
      { customer: 'two\nlines', items: 12, total_eur: 1284.5, paid: true }
    ]);
    const b: CopyBlock = { names: ['a', 'b'], types: ['text', 'json'], rows: [['', '{"k":[1,2]}'], ['x', '']] };
    expect(JSON.parse(copyCells('json', b, IT))).toEqual([{ a: '', b: { k: [1, 2] } }, { a: 'x', b: null }]);
  });
  test('indented two spaces; duplicate names get a suffix', () => {
    const b: CopyBlock = { names: ['a', 'a'], types: ['text', 'text'], rows: [['1', '2']] };
    expect(copyCells('json', b, IT)).toBe('[\n  {\n    "a": "1",\n    "a_2": "2"\n  }\n]');
  });
});

describe('SQL VALUES', () => {
  test('tuples, strings quoted with doubled quotes, numbers with a dot, NULL, TRUE/FALSE', () => {
    expect(copyCells('sql', BLOCK, { ...IT, header: false })).toBe([
      "('Atelier Lumière', 5, 612.90, TRUE),",
      "('Hafen; \"& Co\"', 1, NULL, FALSE),",
      "('two\nlines', 12, 1284.50, TRUE)"
    ].join('\n'));
    const b: CopyBlock = { names: ['n'], types: ['text'], rows: [["O'Brien"], ['']] };
    expect(copyCells('sql', b, { ...IT, header: false })).toBe("('O''Brien'),\n(NULL)");
  });
  test('the header as a column list comment', () => {
    expect(copyCells('sql', BLOCK, IT).split('\n')[0]).toBe('-- customer, items, total_eur, paid');
  });
});

describe('sample', () => {
  const two: CopyBlock = { names: ['items', 'total_eur'], types: ['integer', 'decimal'], rows: [['5', '612,90'], ['1', '49,00'], ['2', '130,00']] };
  test('one short line per format for the menu', () => {
    expect(sample('tsv', two, IT)).toBe('items⇥total_eur');
    expect(sample('tsv', two, { ...IT, header: false })).toBe('5⇥612,90');
    expect(sample('csv', two, IT)).toBe('items;total_eur  ·  5;612,90');
    expect(sample('markdown', two, IT)).toBe('| items | total_eur |\n| ----: | --------: |');
    expect(sample('json', two, IT)).toBe('[{"items": 5, "total_eur": 612.9}, …]');
    expect(sample('sql', two, IT)).toBe('(5, 612.90), (1, 49.00), …');
  });
  test('long samples are cut', () => {
    const b: CopyBlock = { names: ['t'], types: ['text'], rows: [['x'.repeat(200)]] };
    expect(sample('tsv', b, { ...IT, header: false }).length).toBeLessThanOrEqual(80);
    expect(sample('tsv', b, { ...IT, header: false }).endsWith('…')).toBe(true);
  });
});
