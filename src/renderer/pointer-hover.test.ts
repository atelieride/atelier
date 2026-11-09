import { expect, test } from 'vitest';
import { pointerGate } from './pointer-hover';

test('only a pointer that really moved selects: the first event and events at the same spot (a scroll) do not', () => {
  const moved = pointerGate();
  expect(moved({ screenX: 100, screenY: 200 })).toBe(false);
  expect(moved({ screenX: 100, screenY: 200 })).toBe(false);
  expect(moved({ screenX: 100, screenY: 203 })).toBe(true);
  expect(moved({ screenX: 100, screenY: 203 })).toBe(false);
  expect(moved({ screenX: 98, screenY: 203 })).toBe(true);
});
