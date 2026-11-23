import { beforeEach, expect, test, vi } from 'vitest';
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { iphoneOffered, openPairing, useIphone } from './store';

const device = (o: Partial<RemoteDeviceInfo>): RemoteDeviceInfo => ({ id: 'd1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: 1, lastSeenAt: 1, connected: true, attached: [], ...o });
const status = (o: Partial<RemoteStatus> = {}): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });

beforeEach(() => useIphone.setState({ status: null, attached: new Set(), sized: new Set(), pairOpen: false, marksReady: false }));

test('the terminals a connected phone has open, and those a phone sized, as sets', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] }), device({ id: 'd2', connected: false, attached: ['t9'] })], sized: [{ id: 't1', cols: 60, rows: 20 }] }));
  expect([...useIphone.getState().attached]).toEqual(['t1']);
  expect([...useIphone.getState().sized]).toEqual(['t1']);
});

test('a status that changes nothing they show keeps the sets as they were: rows and tabs don\'t re-render', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1', 't2'] })], sized: [{ id: 't2', cols: 60, rows: 20 }] }));
  const { attached, sized } = useIphone.getState();
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t2', 't1'], lastSeenAt: 99 })], sized: [{ id: 't2', cols: 60, rows: 20 }], relay: { state: 'connecting' } }));
  expect(useIphone.getState().attached).toBe(attached);
  expect(useIphone.getState().sized).toBe(sized);
  // The phone's keyboard came: the same terminal at another size (the terminal's view reads the size itself).
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1', 't2'] })], sized: [{ id: 't2', cols: 60, rows: 12 }] }));
  expect(useIphone.getState().sized).toBe(sized);
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] })], sized: [] }));
  expect([...useIphone.getState().attached]).toEqual(['t1']);
  expect(useIphone.getState().sized.size).toBe(0);
});

test('Pair iPhone… opens its sheet where iPhone access is offered, and nothing where it isn\'t (the live demo)', () => {
  // No bridge at all (a view rendered in a unit test): not offered.
  expect(iphoneOffered()).toBe(false);
  vi.stubGlobal('window', { atelier: { remote: { offered: false } } });
  try {
    expect(iphoneOffered()).toBe(false);
    openPairing();
    expect(useIphone.getState().pairOpen).toBe(false);
    vi.stubGlobal('window', { atelier: { remote: { offered: true } } });
    expect(iphoneOffered()).toBe(true);
    openPairing();
    expect(useIphone.getState().pairOpen).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('access off: no badge and no size note, whatever the last list said', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] })], sized: [{ id: 't1', cols: 60, rows: 20 }] }));
  useIphone.getState().setStatus(status({ enabled: false, devices: [device({ attached: ['t1'] })], sized: [{ id: 't1', cols: 60, rows: 20 }] }));
  expect(useIphone.getState().attached.size).toBe(0);
  expect(useIphone.getState().sized.size).toBe(0);
});

test('the marks\' stylesheet comes once access is on, and only then may the marks show', async () => {
  // A store of its own, as a window starts: the stylesheet not asked for yet.
  vi.resetModules();
  const fresh = (await import('./store')).useIphone;
  fresh.getState().setStatus(status({ enabled: false }));
  await new Promise((r) => setTimeout(r, 20));
  expect(fresh.getState().marksReady).toBe(false);
  fresh.getState().setStatus(status({ enabled: true }));
  await expect.poll(() => fresh.getState().marksReady).toBe(true);
});
