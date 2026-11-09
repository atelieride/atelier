import { expect, test } from 'vitest';
import { SnapshotFit } from './snapshot-fit';

test('a screen written at another size than the first fit after it is asked again, once', () => {
  // A terminal behind another tab: its xterm was never fitted (80×24) when atelierd's screen arrived.
  const s = new SnapshotFit();
  s.written(80, 24);
  expect(s.fitted(120, 42)).toBe(true);
  // The second fit (window resized later) is a plain resize.
  expect(s.fitted(100, 30)).toBe(false);
});

test('a screen written at the fitted size needs nothing', () => {
  const s = new SnapshotFit();
  s.written(120, 42);
  expect(s.fitted(120, 42)).toBe(false);
  expect(s.fitted(90, 30)).toBe(false);
});

test('fits with no screen written since then never ask for one', () => {
  const s = new SnapshotFit();
  expect(s.fitted(120, 42)).toBe(false);
  s.written(120, 42);
  expect(s.fitted(120, 42)).toBe(false);
  expect(s.fitted(80, 24)).toBe(false);
});
