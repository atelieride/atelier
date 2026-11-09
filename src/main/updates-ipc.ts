import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, rm, watch } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '@shared/api';
import { currentPlatform } from '@shared/platform';
import { PROTOCOL_VERSION } from '@shared/version';
import type { UpdateChannelSetting } from '@shared/update-feed';
import { UPDATE_PUBLIC_KEYS } from '@shared/update-sign.node';
import { ensureDir } from '../daemon/fsutil';
import { AutoUpdater, SITE_SOURCE, buildChannelOf, localSource, parseTestUpdate } from './auto-update';
import { devEnv } from './dev-env';
import { openUrl, revealFolder } from './links';
import { installStoreUpdates } from './store-updates-ipc';
import { electronOpener } from './update-net';
import { SWAP_SCRIPT, UpdateWatcher, appBundleOf, appLocationProblem, designatedRequirement, previousAppToDrop } from './updates';

const run = (cmd: string, args: string[], timeout = 60_000) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message.split('\n')[0]} ${String(stderr).trim()}`.trim())) : resolve(`${stdout}${stderr}`)));
});

// The in-app updater runs fixed commands only: extracting the update and verifying its code signature.
const UPDATER_COMMANDS = new Set(['/usr/bin/ditto', '/usr/bin/codesign']);
// Extracting ~150 MB and a deep signature check of Electron's frameworks take a while on a busy Mac.
const updaterExec = (cmd: string, args: string[]) => (UPDATER_COMMANDS.has(cmd) ? run(cmd, args, 5 * 60_000) : Promise.reject(new Error(`not allowed: ${cmd}`)));

const canWrite = (p: string) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

const LAUNCH_DELAY = 30_000;
const EVERY = 6 * 60 * 60_000;

export interface UpdatesOptions {
  /** One line in ATELIER_HOME/logs/app.log. */
  log(message: string): void;
  channelSetting(): UpdateChannelSetting;
  /** Called just before the update's own quit (its restart): the sessions must not be asked about or stopped. */
  beforeRestart?(): void;
}

export interface Updates {
  /** "Check for Updates…" (menu, palette, Settings): a manual check, which retries a release that failed before. */
  checkNow(): void;
  /** The channel changed in Settings: show it and check it soon. */
  channelChanged(): void;
  /** A quit was called off (unsaved files, a question cancelled): Windows' Restart must not relaunch at a later quit. */
  quitCalledOff(): void;
}

/** The update's own quit: sessions kept (beforeRestart), and with unsaved files "Save All" closes the windows but the
 * quit stays cancelled: once the last one is closed, quit for real. */
function quitForUpdate(o: UpdatesOptions): void {
  o.beforeRestart?.();
  const onAllClosed = () => app.quit();
  app.once('window-all-closed', onAllClosed);
  // Only while the helper waits (120 s): after that, closing the last window goes back to not quitting the app.
  setTimeout(() => app.removeListener('window-all-closed', onAllClosed), 120_000).unref();
  app.quit();
}

/**
 * "Update ready" (a newer build in ATELIER_HOME/updates/Atelier.app, staged by `npm run stage-update` or by the in-app
 * updater) and the in-app updater itself (auto-update.ts): only in the packaged app, or in tests with a local feed.
 */
export function installUpdates(home: string, trusted: (e: IpcMainInvokeEvent) => boolean, o: UpdatesOptions): Updates {
  const appPath = app.isPackaged ? appBundleOf(process.execPath) : null;
  const updatesDir = join(home, 'updates');
  const watcher = appPath ? new UpdateWatcher({
    appPath, stagedPath: join(updatesDir, 'Atelier.app'), protocol: PROTOCOL_VERSION, exec: run,
    spawnHelper: (args) => spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'sh', ...args], { detached: true, stdio: 'ignore' }).unref(),
    quit: () => quitForUpdate(o),
    canWrite
  }) : null;

  const broadcast = (channel: string, value: unknown) => { for (const b of BrowserWindow.getAllWindows()) b.webContents.send(channel, value); };
  let ready = false;
  const refresh = () => {
    const next = watcher?.ready() ?? false;
    if (next === ready) return;
    ready = next;
    broadcast(IPC.evUpdate, ready);
  };
  if (watcher) {
    void watcher.init().then(refresh);
    app.on('browser-window-focus', refresh);
    // A problem here (folder, watcher) must not stop the app from starting: only the immediate notice is lost.
    try {
      ensureDir(updatesDir, 0o700);
      let timer: NodeJS.Timeout | null = null;
      // The build arrives via a rename in the folder: wait a quiet second, then check again.
      watch(updatesDir, () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 1000); }).on('error', () => {});
    } catch (err) {
      console.error('updates: watcher not started', err);
    }
  }

  // The in-app updater. Tests (devEnv, inert when packaged) point it at a local feed with a fixture app and a test key.
  const test = parseTestUpdate(devEnv('ATELIER_TEST_UPDATE'));
  const ownApp = test?.app ?? appPath;
  const source = (test && localSource(test.feed)) || SITE_SOURCE;
  const updater = new AutoUpdater({
    home, version: app.getVersion(), protocol: PROTOCOL_VERSION, appPath: ownApp,
    buildChannel: test?.channel ?? buildChannelOf(ownApp),
    channelSetting: o.channelSetting,
    available: !!test || (app.isPackaged && !!appPath),
    source,
    publicKeys: test ? [test.publicKey] : UPDATE_PUBLIC_KEYS,
    open: electronOpener(`Atelier/${app.getVersion()} (macOS)`, (u) => source.allow(u)),
    exec: updaterExec,
    ownRequirement: async () => {
      if (test) return test.requirement;
      if (!appPath) return null;
      try { return designatedRequirement(await run('/usr/bin/codesign', ['-d', '-r-', appPath])); } catch { return null; }
    },
    systemVersion: process.getSystemVersion(),
    appLocation: () => (ownApp ? appLocationProblem(ownApp, canWrite) : null),
    log: (m) => o.log(m),
    onStatus: (s) => {
      broadcast(IPC.evUpdateStatus, s);
      // Staged: the footer's "Update ready" right away, without waiting for the folder watcher.
      if (s.phase.kind === 'ready') refresh();
    }
  });
  try { updater.init(); } catch (err) { o.log(`updater: init failed: ${(err as Error).message}`); }
  // The copy SWAP_SCRIPT set aside (rollback) goes once this version has already started before.
  const previous = appPath ? previousAppToDrop(appPath, updater.lastRunVersion(), app.getVersion()) : null;
  if (previous) rm(previous, { recursive: true, force: true }, (err) => o.log(err ? `could not remove ${previous}: ${err.message}` : `removed the previous version (${previous})`));
  // The one-time "What's new" after an update works on every platform (the changelog ships in the app).
  ipcMain.handle(IPC.updateWhatsNew, (e) => (trusted(e) ? updater.takeWhatsNew() : null));
  // Windows: the Microsoft Store updates the app; what follows is macOS's updater.
  if (currentPlatform() === 'win32') return installStoreUpdates(trusted, { log: o.log, broadcast, quitForUpdate: () => quitForUpdate(o) });
  const auto = () => void updater.check({ manual: false });
  if (updater.status().available) {
    setTimeout(auto, LAUNCH_DELAY).unref();
    setInterval(auto, EVERY).unref();
  }
  let soon: NodeJS.Timeout | null = null;

  ipcMain.handle(IPC.updateState, (e) => (trusted(e) ? ready : false));
  ipcMain.handle(IPC.updateApply, async (e) => (trusted(e) && watcher ? watcher.apply() : false));
  ipcMain.handle(IPC.updateStatus, (e) => (trusted(e) ? updater.status() : null));
  // Returns at once (the download can take minutes): progress arrives as status events.
  ipcMain.handle(IPC.updateCheck, (e) => {
    if (!trusted(e)) return null;
    void updater.check({ manual: true });
    return updater.status();
  });
  // The page comes from the main process (fixed repo and tag), never from the renderer.
  ipcMain.handle(IPC.updateOpenRelease, async (e) => {
    if (trusted(e)) await openUrl(updater.releasePage());
  });
  // "Move Atelier to your Applications folder": Finder on /Applications, where the app has to be dragged.
  ipcMain.handle(IPC.updateOpenApplications, async (e) => {
    if (trusted(e)) await revealFolder('/Applications');
  });

  return {
    checkNow: () => void updater.check({ manual: true }),
    channelChanged: () => {
      broadcast(IPC.evUpdateStatus, updater.status());
      if (soon) clearTimeout(soon);
      soon = setTimeout(() => void updater.check({ manual: true }), 1000);
    },
    // macOS's swap helper waits for this app's exit on its own (120 s), as before.
    quitCalledOff: () => {}
  };
}
