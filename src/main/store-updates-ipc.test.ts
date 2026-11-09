import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The Store updater's wiring in main, with Electron stood in for.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown) => unknown>(),
  listeners: new Map<string, () => void>(),
  relaunch: vi.fn(),
  packaged: false
}));
vi.mock('electron', () => ({
  app: { get isPackaged() { return h.packaged; }, getVersion: () => '0.2.0-beta.21', on: (ev: string, fn: () => void) => { h.listeners.set(ev, fn); }, relaunch: h.relaunch },
  ipcMain: { handle: (ch: string, fn: (e: unknown) => unknown) => { h.handlers.set(ch, fn); } }
}));
import { IPC } from '@shared/api';
import type { UpdateStatus } from '@shared/update-feed';
import { installStoreUpdates, storeRunnerFor } from './store-updates-ipc';

const FAMILY = 'FrancescoMusso.AtelierIDE_q82zjjpjsmf54';
const check = (o: { registered: string; updates: number }) => `family ${FAMILY}\nregistered ${o.registered}\nupdates ${o.updates}\nsilent 1\n`;
const ME = { sender: 'app' };
const STRANGER = { sender: 'web' };
const trusted = (e: unknown) => e === ME;

function wire(script: object | null) {
  if (script) {
    const dir = mkdtempSync(join(tmpdir(), 'atl-store-ipc-'));
    writeFileSync(join(dir, 'store.json'), JSON.stringify(script));
    vi.stubEnv('ATELIER_TEST_STORE', join(dir, 'store.json'));
  }
  const quits: string[] = [];
  const updates = installStoreUpdates(trusted, { log: () => {}, broadcast: () => {}, quitForUpdate: () => quits.push('quit') });
  const call = (ch: string, e: unknown = ME) => h.handlers.get(ch)!(e);
  const willQuit = () => h.listeners.get('will-quit')?.();
  return { updates, quits, call, willQuit };
}

beforeEach(() => { h.handlers.clear(); h.listeners.clear(); h.relaunch.mockReset(); h.packaged = false; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const settle = async () => { for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0); };

test('checks 30 s after launch and every 6 h; Restart before anything is ready is refused', async () => {
  const w = wire({ checks: [check({ registered: '0.2.21.0', updates: 0 })] });
  expect(await w.call(IPC.updateApply)).toBe(false);
  expect(((await w.call(IPC.updateStatus)) as UpdateStatus).lastCheck).toBe(null);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(((await w.call(IPC.updateStatus)) as UpdateStatus).lastCheck).toBe(null);
  await vi.advanceTimersByTimeAsync(1_000);
  await settle();
  const first = ((await w.call(IPC.updateStatus)) as UpdateStatus).lastCheck;
  expect(first).not.toBe(null);
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
  await settle();
  expect(((await w.call(IPC.updateStatus)) as UpdateStatus).lastCheck).toBeGreaterThan(first!);
  expect(w.quits).toEqual([]);
});

test('Restart when ready: quits for the update and relaunches the package once, through explorer', async () => {
  const w = wire({ checks: [check({ registered: '0.2.22.0', updates: 0 })] });
  w.updates.checkNow();
  await settle();
  expect(await w.call(IPC.updateState)).toBe(true);
  expect(await w.call(IPC.updateApply, STRANGER)).toBe(false);
  expect(w.quits).toEqual([]);
  expect(await w.call(IPC.updateApply)).toBe(true);
  expect(w.quits).toEqual(['quit']);
  w.willQuit();
  expect(h.relaunch).toHaveBeenCalledTimes(1);
  const { execPath, args } = h.relaunch.mock.calls[0]![0] as { execPath: string; args: string[] };
  expect(execPath).toMatch(/explorer\.exe$/);
  expect(args).toEqual([`shell:AppsFolder\\${FAMILY}!Atelier`]);
  w.willQuit();
  expect(h.relaunch).toHaveBeenCalledTimes(1);
});

test('a quit that was called off (unsaved files, Cancel) relaunches nothing at a later quit; a plain quit never does', async () => {
  const w = wire({ checks: [check({ registered: '0.2.22.0', updates: 0 })] });
  w.willQuit();
  expect(h.relaunch).not.toHaveBeenCalled();
  w.updates.checkNow();
  await settle();
  expect(await w.call(IPC.updateApply)).toBe(true);
  w.updates.quitCalledOff();
  w.willQuit();
  expect(h.relaunch).not.toHaveBeenCalled();
});

test('without the Store (no helper, no identity): not available, no timers, nothing run', async () => {
  const w = wire(null);
  expect(await w.call(IPC.updateStatus)).toMatchObject({ available: false });
  await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
  expect(await w.call(IPC.updateStatus)).toMatchObject({ available: false, lastCheck: null });
  expect(await w.call(IPC.updateStatus, STRANGER)).toBe(null);
});

test('the helper runs only in a packaged app with package identity; tests script the Store instead', () => {
  const base = { test: undefined, packaged: true, windowsStore: true, resources: 'C:\\Atelier\\resources', exists: () => true };
  expect(storeRunnerFor(base)).not.toBe(null);
  expect(storeRunnerFor({ ...base, windowsStore: false })).toBe(null);
  expect(storeRunnerFor({ ...base, packaged: false })).toBe(null);
  expect(storeRunnerFor({ ...base, exists: () => false })).toBe(null);
  expect(storeRunnerFor({ ...base, resources: undefined })).toBe(null);
  expect(storeRunnerFor({ ...base, packaged: false, windowsStore: false, test: 'C:\\t\\store.json' })).not.toBe(null);
});
