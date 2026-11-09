// The tab tear-off's ghost window as TearOff sees it. Main fills its static page
// in with executeJavaScript and JSON-encoded values once it has loaded; the page sets text with textContent only.
import type { Rectangle } from 'electron';
import { createGhostWindow } from './windows';
import { showGhost } from './hidden-windows';
import type { GhostWin } from './tear-off';

export function makeGhost(bounds: Rectangle, zoomFactor: number): GhostWin {
  const win = createGhostWindow(bounds, zoomFactor);
  showGhost(win);
  let loaded = false;
  const queued: string[] = [];
  const run = (js: string) => {
    if (win.isDestroyed()) return;
    if (!loaded) { queued.push(js); return; }
    void win.webContents.executeJavaScript(js, false).catch(() => {});
  };
  win.webContents.once('did-finish-load', () => { loaded = true; for (const js of queued.splice(0)) run(js); });
  return {
    setBounds: (b) => { if (!win.isDestroyed()) win.setBounds(b); },
    setOpacity: (o) => { if (!win.isDestroyed()) win.setOpacity(o); },
    destroy: () => { if (!win.isDestroyed()) win.destroy(); },
    isDestroyed: () => win.isDestroyed(),
    fill: (info) => run(`window.__ghost?.fill(${JSON.stringify(info)})`),
    snapshot: (url) => run(`window.__ghost?.snapshot(${JSON.stringify(url)})`)
  };
}
