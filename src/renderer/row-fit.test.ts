import { describe, expect, test } from 'vitest';
import { cutsName, worthTrial } from './row-fit';

describe('a row\'s chips give way to its name', () => {
  test('full chips stay while the name shows whole', () => {
    expect(cutsName({ need: 80, room: 80, chips: 60 })).toBe(false);
  });

  test('they go compact once they cut the name', () => {
    expect(cutsName({ need: 140, room: 80, chips: 60 })).toBe(true);
  });

  test('a long name alone (no chips) has nothing to gain: no compact form', () => {
    expect(cutsName({ need: 300, room: 120, chips: 0 })).toBe(false);
  });

  test('sub-pixel differences never count as a cut name', () => {
    expect(cutsName({ need: 80.4, room: 80, chips: 60 })).toBe(false);
    expect(cutsName({ need: 80.7, room: 80, chips: 60 })).toBe(true);
  });
});

describe('compact, a trial in the full layout only when it can succeed', () => {
  const fit = { full: 60, sig: 'a' };

  test('not while full chips, as last measured, would still cut the name', () => {
    // 20 px of compact chips, 60 full: growing back takes 40 px from a room of 150, leaving 110 for a 140 px name.
    expect(worthTrial(fit, { need: 140, room: 150, chips: 20, sig: 'a' })).toBe(false);
  });

  test('once they would fit beside the whole name', () => {
    expect(worthTrial(fit, { need: 140, room: 180, chips: 20, sig: 'a' })).toBe(true);
  });

  test('whenever the chips changed since (a server stopped: their old width says nothing)', () => {
    expect(worthTrial(fit, { need: 140, room: 150, chips: 20, sig: 'b' })).toBe(true);
  });
});
