import { expect, test } from 'vitest';
import { liveSpots, type MeasuredSpot } from '../e2e/site-shots/live-spots';

const window = { x: 0, y: 0, width: 1440, height: 900 };

test('spots keep their size and are placed relative to the captured area', () => {
  const measured: MeasuredSpot[] = [{ kind: 'glow', x: 100, y: 40, w: 8, h: 8, r: 4 }];
  expect(liveSpots(measured, window)).toEqual({ width: 1440, height: 900, spots: [{ kind: 'glow', x: 100, y: 40, w: 8, h: 8, r: 4 }] });
  expect(liveSpots(measured, { x: 50, y: 20, width: 600, height: 400 }).spots).toEqual([{ kind: 'glow', x: 50, y: 20, w: 8, h: 8, r: 4 }]);
});

test('spots outside the captured area, partly cut or of no size are dropped (a pulse must sit on what the shot shows)', () => {
  const clip = { x: 0, y: 0, width: 900, height: 600 };
  const measured: MeasuredSpot[] = [
    { kind: 'glow', x: 1200, y: 40, w: 8, h: 8, r: 4 },
    { kind: 'glow', x: 640, y: 120, w: 800, h: 700, r: 10 },
    { kind: 'glow', x: 10, y: 10, w: 0, h: 12, r: 0 },
    { kind: 'glow', x: 130, y: 220, w: 28, h: 28, r: 7 }
  ];
  expect(liveSpots(measured, clip).spots).toEqual([{ kind: 'glow', x: 130, y: 220, w: 28, h: 28, r: 7 }]);
});

test('a radius given in percent (round dots: 50%) becomes pixels of the spot\'s smaller side', () => {
  expect(liveSpots([{ kind: 'glow', x: 10, y: 10, w: 7, h: 7, r: '50%' }], window).spots[0]!.r).toBe(3.5);
  expect(liveSpots([{ kind: 'glow', x: 10, y: 10, w: 26, h: 20, r: '8px' }], window).spots[0]!.r).toBe(8);
});

test('coordinates are rounded to tenths of a pixel (stable diffs when shots are regenerated)', () => {
  expect(liveSpots([{ kind: 'glow', x: 100.123, y: 40.987, w: 7.96, h: 8.04, r: 3.99 }], window).spots[0]).toEqual({ kind: 'glow', x: 100.1, y: 41, w: 8, h: 8, r: 4 });
});
