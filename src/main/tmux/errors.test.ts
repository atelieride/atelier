import { expect, test } from 'vitest';
import { nextErrors } from './errors';

test('the first capture is history even when it arrives as appended lines', () => {
  expect(nextErrors({ committed: 0 }, { reset: false, first: true, appended: ['error: old'], live: '', seen: false }).total).toBe(0);
});

test('first-capture history does not count; new errors do; looking at the pane clears them', () => {
  let s = nextErrors({ committed: 0 }, { reset: true, first: true, appended: ['error: old', 'error: old 2'], live: '', seen: false });
  expect(s.total).toBe(0);
  s = nextErrors(s, { reset: false, first: false, appended: ['error: new'], live: 'ok', seen: false });
  expect(s.total).toBe(1);
  s = nextErrors(s, { reset: false, first: false, appended: [], live: 'error: in progress', seen: false });
  expect(s.total).toBe(2);
  s = nextErrors(s, { reset: false, first: false, appended: ['error: other'], live: '', seen: true });
  expect(s.total).toBe(0);
});
