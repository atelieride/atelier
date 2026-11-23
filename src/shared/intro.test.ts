import { expect, test } from 'vitest';
import { IntroGate, introArg, introFromArgv } from './intro';

const on = { launchAnimation: true, motion: 'system' as const, hidden: false, testIntro: false };

test('the launch argument round-trips the hold; no argument means no animation; garbage holds 0', () => {
  expect(introFromArgv([introArg()])).toBe(0);
  expect(introFromArgv([introArg(1500)])).toBe(1500);
  expect(introFromArgv(['--atelier-theme=aurora'])).toBeNull();
  expect(introFromArgv(['--atelier-intro=x'])).toBe(0);
});

test('the gate lets one window through, the first', () => {
  const g = new IntroGate();
  expect(g.take(on)).toBe(true);
  expect(g.take(on)).toBe(false);
});

test('a first window that did not get it uses the chance up', () => {
  const g = new IntroGate();
  expect(g.take({ ...on, launchAnimation: false })).toBe(false);
  expect(g.take(on)).toBe(false);
});

test('reduced motion and hidden windows say no, unless a test asks for it', () => {
  expect(new IntroGate().take({ ...on, motion: 'reduced' })).toBe(false);
  expect(new IntroGate().take({ ...on, hidden: true })).toBe(false);
  expect(new IntroGate().take({ ...on, hidden: true, testIntro: true })).toBe(true);
});
