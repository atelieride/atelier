import { expect, test } from 'vitest';
import { neverSent } from './daemon-errors';

test('never sent: no connection or an incompatible atelierd, also wrapped by IPC; anything else may have arrived', () => {
  expect(neverSent(new Error('atelierd not connected'))).toBe(true);
  expect(neverSent(new Error("Error invoking remote method 'term:close': Error: atelierd not connected"))).toBe(true);
  expect(neverSent(new Error('atelierd incompatible'))).toBe(true);
  for (const m of ['atelierd not responding', 'atelierd disconnected', 'unknown terminal: x']) expect(neverSent(new Error(m))).toBe(false);
  expect(neverSent('atelierd not connected')).toBe(true);
});
