import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/api';
import type { AppLog } from './app-log';
import { rendererErrorSchema } from './ipc-schemas';

/**
 * What used to vanish without a trace (a blank window, a crashed or hung renderer) goes to ATELIER_HOME/logs/app.log:
 * renderer errors sent by the page (uncaught, unhandled rejections, error boundaries) and the main process's view of
 * its pages and helper processes. `testFault`: the panel e2e tests make throw (devEnv, null in the packaged app).
 */
export function installErrorLog(log: AppLog, trusted: (e: IpcMainEvent | IpcMainInvokeEvent) => boolean, testFault: string | null): void {
  ipcMain.on(IPC.logError, (e, arg) => {
    if (!trusted(e)) return;
    const o = rendererErrorSchema.safeParse(arg);
    if (o.success) log.write({ source: `renderer:${o.data.kind}`, message: o.data.message, stack: o.data.stack, panel: o.data.panel });
  });
  ipcMain.handle(IPC.testFault, (e) => (trusted(e) ? testFault : null));
  app.on('render-process-gone', (_e, _wc, d) => { log.write({ source: 'main:render-process-gone', message: `${d.reason}, exit code ${d.exitCode}` }); });
  // The GPU process crashing can also leave a window blank.
  app.on('child-process-gone', (_e, d) => { log.write({ source: 'main:child-process-gone', message: `${d.type} ${d.reason}, exit code ${d.exitCode}${d.name ? ` (${d.name})` : ''}` }); });
  app.on('browser-window-created', (_e, win) => {
    win.on('unresponsive', () => log.write({ source: 'main:unresponsive', message: 'a window stopped responding' }));
    win.on('responsive', () => log.write({ source: 'main:responsive', message: 'the window responds again' }));
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.on('preload-error', (_ev, _path, err) => { log.write({ source: 'main:preload-error', message: err.message, stack: err.stack }); });
  });
  // Observed only: Electron's own handling of an uncaught main-process exception stays as it is.
  process.on('uncaughtExceptionMonitor', (err) => { log.write({ source: 'main:uncaught', message: err?.message ?? String(err), stack: err?.stack }); });
}
