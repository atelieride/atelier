import { beforeEach, expect, test, vi } from 'vitest';
import type { RemoteDeviceInfo, RemoteStatus } from '@shared/remote';
import { useIphone } from './store';

const device = (o: Partial<RemoteDeviceInfo>): RemoteDeviceInfo => ({ id: 'd1', name: 'Test iPhone', model: 'iPhone17,1', pairedAt: 1, lastSeenAt: 1, connected: true, attached: [], ...o });
const status = (o: Partial<RemoteStatus> = {}): RemoteStatus => ({ enabled: true, available: true, relay: { state: 'online' }, devices: [], sized: [], ...o });

beforeEach(() => useIphone.setState({ status: null, attached: new Set(), sized: new Set(), pairOpen: false, marksReady: false }));

test('the terminals a connected phone has open, and those a phone sized, as sets', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] }), device({ id: 'd2', connected: false, attached: ['t9'] })], sized: ['t1'] }));
  expect([...useIphone.getState().attached]).toEqual(['t1']);
  expect([...useIphone.getState().sized]).toEqual(['t1']);
});

test('a status that changes nothing they show keeps the sets as they were: rows and tabs don\'t re-render', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1', 't2'] })], sized: ['t2'] }));
  const { attached, sized } = useIphone.getState();
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t2', 't1'], lastSeenAt: 99 })], sized: ['t2'], relay: { state: 'connecting' } }));
  expect(useIphone.getState().attached).toBe(attached);
  expect(useIphone.getState().sized).toBe(sized);
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] })], sized: [] }));
  expect([...useIphone.getState().attached]).toEqual(['t1']);
  expect(useIphone.getState().sized.size).toBe(0);
});

test('access off: no badge and no size note, whatever the last list said', () => {
  useIphone.getState().setStatus(status({ devices: [device({ attached: ['t1'] })], sized: ['t1'] }));
  useIphone.getState().setStatus(status({ enabled: false, devices: [device({ attached: ['t1'] })], sized: ['t1'] }));
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
