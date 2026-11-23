import { expect, test } from 'vitest';
import { TerminalSizes } from './terminal-sizes';

const s = (cols: number, rows: number) => ({ cols, rows });
const WIN = 1; const POP = 2; const PHONE = -1;

test('the viewer that asks last owns the size; a size the terminal already has is not sent again', () => {
  const z = new TerminalSizes();
  expect(z.ask(WIN, 't', s(120, 40))).toEqual(s(120, 40));
  expect(z.ask(WIN, 't', s(120, 40))).toBeNull();
  expect(z.ask(PHONE, 't', s(60, 30))).toEqual(s(60, 30));
  expect(z.owner('t')).toBe(PHONE);
  expect(z.current('t')).toEqual(s(60, 30));
  expect(z.asked(WIN, 't')).toEqual(s(120, 40));
});

test('asking without taking only records the viewer\'s size', () => {
  const z = new TerminalSizes();
  z.ask(WIN, 't', s(120, 40));
  expect(z.ask(PHONE, 't', s(60, 30), false)).toBeNull();
  expect(z.owner('t')).toBe(WIN);
  expect(z.asked(PHONE, 't')).toEqual(s(60, 30));
});

test('typing takes the size back with the typist\'s own size, only from an owner it may take it from', () => {
  const z = new TerminalSizes();
  z.ask(WIN, 't', s(120, 40));
  z.ask(PHONE, 't', s(60, 30));
  const fromPhone = (owner: number) => owner < 0;
  expect(z.takeBack(WIN, 't', fromPhone)).toEqual(s(120, 40));
  expect(z.owner('t')).toBe(WIN);
  // Its own already: nothing; from another window: not by typing.
  expect(z.takeBack(WIN, 't', fromPhone)).toBeNull();
  z.ask(POP, 't', s(100, 30));
  expect(z.takeBack(WIN, 't', fromPhone)).toBeNull();
  // A viewer with no size of its own has nothing to take back with.
  expect(z.takeBack(3, 't', () => true)).toBeNull();
});

test('the owner leaving: the most recent other viewer with a size takes it; none, the size stays', () => {
  const z = new TerminalSizes();
  z.ask(POP, 't', s(100, 30));
  z.ask(WIN, 't', s(120, 40));
  z.ask(PHONE, 't', s(60, 30));
  expect(z.leave(PHONE, 't', [POP, WIN])).toEqual(s(120, 40));
  expect(z.owner('t')).toBe(WIN);
  expect(z.asked(PHONE, 't')).toBeUndefined();
  // A viewer that doesn't own it leaves: nothing moves.
  expect(z.leave(POP, 't', [WIN])).toBeNull();
  expect(z.leave(WIN, 't', [])).toBeNull();
  expect(z.owner('t')).toBeUndefined();
  expect(z.current('t')).toEqual(s(120, 40));
});

test('the size taken back by a viewer whose size the terminal already has is no resize', () => {
  const z = new TerminalSizes();
  z.ask(WIN, 't', s(80, 24));
  z.ask(PHONE, 't', s(80, 24));
  expect(z.leave(PHONE, 't', [WIN])).toBeNull();
  expect(z.owner('t')).toBe(WIN);
});

test('sizes owned by phones; a terminal gone, a viewer gone, atelierd reconnecting', () => {
  const z = new TerminalSizes();
  z.ask(PHONE, 'a', s(60, 30));
  z.ask(WIN, 'b', s(120, 40));
  z.known('c', s(120, 36));
  expect(z.current('c')).toEqual(s(120, 36));
  expect(z.owned((v) => v < 0)).toEqual(['a']);
  z.forgetTerminal('a');
  expect(z.owned((v) => v < 0)).toEqual([]);
  z.forgetViewer(WIN);
  expect(z.asked(WIN, 'b')).toBeUndefined();
  expect(z.owner('b')).toBeUndefined();
  z.ask(WIN, 'b', s(120, 40));
  z.unknown();
  // atelierd may have restarted: the next ask is sent again, whoever owns it.
  expect(z.current('b')).toBeUndefined();
  expect(z.asked(WIN, 'b')).toEqual(s(120, 40));
  expect(z.ask(WIN, 'b', s(120, 40))).toEqual(s(120, 40));
});
