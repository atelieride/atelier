import { describe, expect, test } from 'vitest';
import { CHECK_BOTTOM, CHECK_GAP, checklistPlace } from './make-way';

// "Things to try" floats bottom right, over the Changes panel's commit bar and drawer. It makes way:
// above the bar while the drawer is closed (the workspace stays uncovered), left of the panel while the drawer is open.

const W = 1440;
const H = 900;
const panel = { left: 1136, width: 304 };

describe('checklistPlace', () => {
  test('no Changes panel (or one not laid out): its usual place', () => {
    expect(checklistPlace({ changes: null, barTop: null, drawer: false, width: W, height: H })).toEqual({ right: CHECK_GAP, bottom: CHECK_BOTTOM });
    expect(checklistPlace({ changes: { left: 0, width: 0 }, barTop: 800, drawer: true, width: W, height: H })).toEqual({ right: CHECK_GAP, bottom: CHECK_BOTTOM });
  });

  test('the panel with its bar: the list stays on the right, lifted just above the bar', () => {
    expect(checklistPlace({ changes: panel, barTop: 830, drawer: false, width: W, height: H })).toEqual({ right: CHECK_GAP, bottom: H - 830 + 8 });
    // A bar lower than the usual place changes nothing.
    expect(checklistPlace({ changes: panel, barTop: H - 20, drawer: false, width: W, height: H })).toEqual({ right: CHECK_GAP, bottom: CHECK_BOTTOM });
  });

  test('the drawer open: just left of the panel, at its usual height', () => {
    expect(checklistPlace({ changes: panel, barTop: null, drawer: true, width: W, height: H })).toEqual({ right: W - 1136 + CHECK_GAP, bottom: CHECK_BOTTOM });
  });
});

// Ask: its panel docks at the session pane's right edge, its composer and Send at the
// bottom right, exactly where the list floats. The list moves just left of the panel when it would cover any of it.
describe('checklistPlace with an Ask panel', () => {
  const none = { changes: null, barTop: null, drawer: false, width: W, height: H };
  test('Ask at the window\'s right edge (no Changes): the list goes just left of it', () => {
    const ask = { left: W - 404, width: 404 };
    expect(checklistPlace({ ...none, ask })).toEqual({ right: 404 + CHECK_GAP, bottom: CHECK_BOTTOM });
  });

  test('Ask beside the Changes panel: the list over the commit bar would still touch it, so it moves left of Ask', () => {
    const ask = { left: 1136 - 404, width: 404 };
    expect(checklistPlace({ changes: panel, barTop: 830, drawer: false, width: W, height: H, ask })).toEqual({ right: W - (1136 - 404) + CHECK_GAP, bottom: CHECK_BOTTOM });
  });

  test('an Ask panel the list does not touch (a pane on the left of a split) changes nothing', () => {
    expect(checklistPlace({ ...none, ask: { left: 300, width: 404 } })).toEqual({ right: CHECK_GAP, bottom: CHECK_BOTTOM });
    expect(checklistPlace({ ...none, ask: { left: 0, width: 0 } })).toEqual({ right: CHECK_GAP, bottom: CHECK_BOTTOM });
  });
});
