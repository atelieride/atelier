import { expect, test } from 'vitest';
import { SERVICES_PACE as P, captureDue, listDue } from './services-pace';

test('lists every 3 s while focused, also with no server or no panes (a tmux started now shows at once); every 30 s unfocused or without tmux', () => {
  const base = { last: 0, focused: true, status: 'ok' as const, panes: 2 };
  expect(listDue({ ...base, now: P.listMs - P.tickMs })).toBe(false);
  expect(listDue({ ...base, now: P.listMs })).toBe(true);
  for (const o of [{ status: 'no-server' as const }, { panes: 0 }]) expect(listDue({ ...base, ...o, now: P.listMs })).toBe(true);
  for (const o of [{ focused: false }, { status: 'no-tmux' as const }]) {
    expect(listDue({ ...base, ...o, now: P.listMs })).toBe(false);
    expect(listDue({ ...base, ...o, now: P.restMs })).toBe(true);
  }
});

test('captures watched panes every 1 s and others every 5 s while focused; every 30 s unfocused (the footer count still moves)', () => {
  const base = { last: 0, focused: true, watched: false };
  expect(captureDue({ ...base, now: P.idleCaptureMs })).toBe(true);
  expect(captureDue({ ...base, watched: true, now: P.watchedCaptureMs })).toBe(true);
  expect(captureDue({ ...base, focused: false, now: P.idleCaptureMs })).toBe(false);
  expect(captureDue({ ...base, focused: false, watched: true, now: P.watchedCaptureMs })).toBe(false);
  expect(captureDue({ ...base, focused: false, now: P.restMs })).toBe(true);
});

test('a tick firing a little early still counts (half a tick of tolerance): watched panes stay at 1 s, not 2 s', () => {
  const early = P.tickMs / 2 - 1;
  expect(captureDue({ last: 0, now: P.watchedCaptureMs - early, focused: true, watched: true })).toBe(true);
  expect(captureDue({ last: 0, now: P.idleCaptureMs - early, focused: true, watched: false })).toBe(true);
  expect(listDue({ last: 0, now: P.listMs - early, focused: true, status: 'ok', panes: 1 })).toBe(true);
  expect(captureDue({ last: 0, now: P.watchedCaptureMs - P.tickMs, focused: true, watched: true })).toBe(false);
});
