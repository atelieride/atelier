import { describe, expect, test } from 'vitest';
import { address, columnIndex, columnLetter, formatNumber, groupInt, jsonCell, parseGoTo, rangeAddress, toNumber } from './format';

const T = ' ';

describe('column letters', () => {
  test('A…Z, then AA, AZ, BA, ZZ, AAA', () => {
    expect([0, 1, 25, 26, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
  test('back to an index, any case; null for anything else', () => {
    expect(['A', 'z', 'AA', 'ZZ', 'AAA'].map(columnIndex)).toEqual([0, 25, 26, 701, 702]);
    expect(columnIndex('')).toBeNull();
    expect(columnIndex('A1')).toBeNull();
  });
});

describe('addresses', () => {
  test('a cell: letter and 1-based row', () => {
    expect(address(5, 6)).toBe('G6');
    expect(address(0, 0)).toBe('A1');
  });
  test('a range in either order; one cell is that cell', () => {
    expect(rangeAddress({ r0: 2, c0: 5, r1: 8, c1: 6 })).toBe('F3:G9');
    expect(rangeAddress({ r0: 8, c0: 6, r1: 2, c1: 5 })).toBe('F3:G9');
    expect(rangeAddress({ r0: 5, c0: 6, r1: 5, c1: 6 })).toBe('G6');
  });
});

describe('toNumber', () => {
  test('dot decimal: plain, grouped with commas, exponent, signs, spaces trimmed', () => {
    expect(toNumber('284.50', '.')).toBe(284.5);
    expect(toNumber('1,284.50', '.')).toBe(1284.5);
    expect(toNumber('12,345,678', '.')).toBe(12345678);
    expect(toNumber('1e3', '.')).toBe(1000);
    expect(toNumber('-2.5E-2', '.')).toBe(-0.025);
    expect(toNumber('+7', '.')).toBe(7);
    expect(toNumber('  42 ', '.')).toBe(42);
    expect(toNumber('0', '.')).toBe(0);
    expect(toNumber('0.75', '.')).toBe(0.75);
    expect(toNumber('.5', '.')).toBe(0.5);
  });
  test('comma decimal: plain, grouped with dots', () => {
    expect(toNumber('284,50', ',')).toBe(284.5);
    expect(toNumber('1284,00', ',')).toBe(1284);
    expect(toNumber('1.284,50', ',')).toBe(1284.5);
    expect(toNumber('-0,5', ',')).toBe(-0.5);
  });
  test('not numbers: leading zeros, the other separator alone, text, empty, bad groups', () => {
    expect(toNumber('00123', '.')).toBeNull();
    expect(toNumber('007', ',')).toBeNull();
    expect(toNumber('284,50', '.')).toBeNull();
    expect(toNumber('1,28', '.')).toBeNull();
    expect(toNumber('12.5', ',')).toBeNull();
    expect(toNumber('', '.')).toBeNull();
    expect(toNumber('abc', '.')).toBeNull();
    expect(toNumber('1.2.3', '.')).toBeNull();
    expect(toNumber('Infinity', '.')).toBeNull();
    expect(toNumber('0x1F', '.')).toBeNull();
  });
});

describe('formatNumber', () => {
  test('thin-space groups in the integer part, the file’s separator and decimals kept', () => {
    expect(formatNumber('1284,50', ',')).toBe(`1${T}284,50`);
    expect(formatNumber('1.284,50', ',')).toBe(`1${T}284,50`);
    expect(formatNumber('2310', '.')).toBe(`2${T}310`);
    expect(formatNumber('1,234,567.125', '.')).toBe(`1${T}234${T}567.125`);
    expect(formatNumber('-48213', '.')).toBe(`-48${T}213`);
    expect(formatNumber('284.5', '.')).toBe('284.5');
    expect(formatNumber('999', '.')).toBe('999');
  });
  test('exponents and non-numbers stay as they are (trimmed)', () => {
    expect(formatNumber('1e30', '.')).toBe('1e30');
    expect(formatNumber(' abc ', '.')).toBe('abc');
  });
});

describe('groupInt', () => {
  test('thin-space groups', () => {
    expect(groupInt(61204)).toBe(`61${T}204`);
    expect(groupInt(999)).toBe('999');
    expect(groupInt(1234567)).toBe(`1${T}234${T}567`);
  });
});

describe('parseGoTo', () => {
  test('a row number (1-based in, 0-based out), clamped', () => {
    expect(parseGoTo('48213', 61204)).toEqual({ row: 48212, col: null });
    expect(parseGoTo(' 1 ', 10)).toEqual({ row: 0, col: null });
    expect(parseGoTo('999', 10)).toEqual({ row: 9, col: null });
    expect(parseGoTo('0', 10)).toEqual({ row: 0, col: null });
  });
  test('a cell address', () => {
    expect(parseGoTo('H48213', 61204)).toEqual({ row: 48212, col: 7 });
    expect(parseGoTo('aa3', 10)).toEqual({ row: 2, col: 26 });
  });
  test('negative counts from the end', () => {
    expect(parseGoTo('-1', 10)).toEqual({ row: 9, col: null });
    expect(parseGoTo('-3', 10)).toEqual({ row: 7, col: null });
    expect(parseGoTo('-99', 10)).toEqual({ row: 0, col: null });
  });
  test('thin spaces and commas in numbers are ignored', () => {
    expect(parseGoTo(`48${T}213`, 61204)).toEqual({ row: 48212, col: null });
    expect(parseGoTo('48,213', 61204)).toEqual({ row: 48212, col: null });
  });
  test('nothing for junk or an empty table', () => {
    expect(parseGoTo('', 10)).toBeNull();
    expect(parseGoTo('abc', 10)).toBeNull();
    expect(parseGoTo('H', 10)).toBeNull();
    expect(parseGoTo('5', 0)).toBeNull();
  });
});

describe('jsonCell', () => {
  test('an object or array: its count chip and a one-line preview of the first entries', () => {
    expect(jsonCell('{"method":"POST","cart":{"items":4},"retry":false,"flags":["a"],"n":1}')).toEqual({
      chip: '{5}', preview: 'method: "POST", cart: {…}, retry: false, flags: […], …', kind: 'object', entries: 5
    });
    expect(jsonCell('[1, "two", null]')).toEqual({ chip: '[3]', preview: '1, "two", null', kind: 'array', entries: 3 });
    expect(jsonCell('{}')).toEqual({ chip: '{0}', preview: '', kind: 'object', entries: 0 });
  });
  test('anything else: null', () => {
    expect(jsonCell('plain')).toBeNull();
    expect(jsonCell('{broken')).toBeNull();
    expect(jsonCell('42')).toBeNull();
  });
});
