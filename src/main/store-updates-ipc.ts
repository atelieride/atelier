import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { IPC } from '@shared/api';
import { windowsBuild } from '@shared/store-updates';
import { devEnv, testMs } from './dev-env';
import { openStorePage } from './links';
import { fakeRunner, helperRunner } from './store-exec';
import { RelaunchArm, StoreUpdater, type StoreRunner } from './store-updates';
import type { Updates } from './updates-ipc';

// Windows: the update IPC served by the Microsoft Store. Same channels as
// macOS's updater, so the footer and Settings › About need no second path; installUpdates picks this on win32.

const LAUNCH_DELAY = 30_000;
const EVERY = 6 * 60 * 60_000;

export interface StoreUpdatesOptions {
  log(message: string): void;
  broadcast(channel: string, value: unknown): void;
  /** The update's own quit (sessions kept, unsaved files asked as usual), shared with macOS's restart. */
  quitForUpdate(): void;
}

/**
 * Tests (devEnv, inert when packaged) script the Store; the app runs its own helper only where the Store can answer:
 * packaged and with the package's identity (Electron's process.windowsStore). An unpacked build or a dev run has none.
 */
export function storeRunnerFor(o: { test: string | undefined; packaged: boolean; windowsStore: boolean; resources: string | undefined; exists(path: string): boolean }): StoreRunner | null {
  if (o.test) return fakeRunner(o.test);
  if (!o.packaged || !o.windowsStore || !o.resources) return null;
  const exe = join(o.resources, 'bin', 'atelier-store.exe');
  return o.exists(exe) ? helperRunner(exe) : null;
}

export function installStoreUpdates(trusted: (e: IpcMainInvokeEvent) => boolean, o: StoreUpdatesOptions): Updates {
  const runner = storeRunnerFor({
    test: devEnv('ATELIER_TEST_STORE'), packaged: app.isPackaged, windowsStore: process.windowsStore === true,
    resources: process.resourcesPath, exists: existsSync
  });
  let ready = false;
  const updater = new StoreUpdater({
    version: app.getVersion(), build: windowsBuild(release()), runner, now: () => Date.now(), log: (m) => o.log(m),
    onStatus: (s) => {
      o.broadcast(IPC.evUpdateStatus, s);
      const next = s.phase.kind === 'ready';
      if (next !== ready) { ready = next; o.broadcast(IPC.evUpdate, ready); }
    }
  });
  const auto = () => void updater.check();
  if (updater.status().available) {
    setTimeout(auto, testMs('ATELIER_TEST_STORE_DELAY_MS') ?? LAUNCH_DELAY).unref();
    setInterval(auto, EVERY).unref();
  }

  // Restart: once Atelier has exited, Electron's relauncher has Windows start the package's app (explorer resolves
  // shell:AppsFolder), i.e. the registered new version. Set on will-quit, when the quit is no longer cancelled by a window.
  const arm = new RelaunchArm();
  app.on('will-quit', () => {
    const target = arm.take(Date.now());
    if (!target) return;
    o.log(`restarting into the registered version (${target})`);
    const log = devEnv('ATELIER_TEST_RELAUNCH_LOG');
    if (log) { appendFileSync(log, target + '\n'); return; }
    app.relaunch({ execPath: join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), args: [target] });
  });

  ipcMain.handle(IPC.updateState, (e) => (trusted(e) ? ready : false));
  ipcMain.handle(IPC.updateApply, (e) => {
    const family = updater.family();
    if (!trusted(e) || !updater.ready() || !family) return false;
    arm.arm(family, Date.now());
    o.quitForUpdate();
    return true;
  });
  ipcMain.handle(IPC.updateStatus, (e) => (trusted(e) ? updater.status() : null));
  // Returns at once (a download takes a while): what follows arrives as status events.
  ipcMain.handle(IPC.updateCheck, (e) => {
    if (!trusted(e)) return null;
    void updater.check();
    return updater.status();
  });
  ipcMain.handle(IPC.updateOpenStore, async (e) => { if (trusted(e)) await openStorePage(); });

  return { checkNow: () => void updater.check(), channelChanged: () => {}, quitCalledOff: () => arm.disarm() };
}
