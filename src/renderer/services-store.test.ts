import { beforeEach, expect, test } from 'vitest';
import { useApp } from './store';

beforeEach(() => useApp.setState({ serviceLines: {}, serviceSeq: {}, servicesOpen: false, activeTab: 'term', maximized: null, openFiles: [] }));

test('service lines: appended, capped at 5000, cleared on reset; sequence updated', () => {
  const s = useApp.getState();
  s.setServiceBuffer('%1', [], 0);
  s.appendServiceLines('%1', Array.from({ length: 4990 }, (_, i) => `l${i}`), false, 4990);
  s.appendServiceLines('%1', Array.from({ length: 20 }, (_, i) => `m${i}`), false, 5010);
  expect(useApp.getState().serviceLines['%1']).toHaveLength(5000);
  expect(useApp.getState().serviceLines['%1']!.at(-1)).toBe('m19');
  expect(useApp.getState().serviceSeq['%1']).toBe(5010);
  useApp.getState().appendServiceLines('%1', ['x'], true, 1);
  expect(useApp.getState().serviceLines['%1']).toEqual(['x']);
});
test('update with a gap in the sequence → flagged for a refetch', () => {
  const s = useApp.getState();
  s.setServiceBuffer('%1', ['a'], 1);
  expect(s.appendServiceLines('%1', ['c'], false, 3)).toBe('refetch');
  expect(useApp.getState().serviceLines['%1']).toEqual(['a']);
});
test('pane not loaded yet → update ignored', () => {
  expect(useApp.getState().appendServiceLines('%9', ['x'], false, 1)).toBe('ignored');
});
test('openServices opens the tab and maximizes; closing it goes back to the terminal', () => {
  useApp.getState().openServices('%2');
  expect(useApp.getState()).toMatchObject({ servicesOpen: true, activeTab: 'services', maximized: '%2' });
  useApp.getState().closeTab('services');
  expect(useApp.getState()).toMatchObject({ servicesOpen: false, activeTab: 'term' });
});

test('live line (the last of the capture): shown separately and replaced on every update', () => {
  const s = useApp.getState();
  s.setServiceBuffer('%1', ['a'], 1, 'listening on port 3999');
  expect(useApp.getState().serviceLive['%1']).toBe('listening on port 3999');
  s.appendServiceLines('%1', ['listening on port 3999'], false, 2, 'GET /x 200');
  expect(useApp.getState().serviceLines['%1']).toEqual(['a', 'listening on port 3999']);
  expect(useApp.getState().serviceLive['%1']).toBe('GET /x 200');
});

import { lineKey } from './components/ServicesView';
test('line key = absolute number: stable even when the buffer scrolls past 5000', () => {
  // 5000-line buffer with 7000 received: the first one shown (of the last 1500) is the 5500th
  expect(lineKey(7000, 5000, 1500, 0)).toBe(5500);
  expect(lineKey(7001, 5000, 1500, 0)).toBe(5501);
});

test('wrap lines: per pane, toggled, for the window\'s life', () => {
  useApp.setState({ serviceWrap: {} });
  const s = useApp.getState();
  expect(useApp.getState().serviceWrap['%1']).toBeFalsy();
  s.toggleServiceWrap('%1');
  expect(useApp.getState().serviceWrap['%1']).toBe(true);
  expect(useApp.getState().serviceWrap['%2']).toBeFalsy();
  s.toggleServiceWrap('%1');
  expect(useApp.getState().serviceWrap['%1']).toBeFalsy();
});
