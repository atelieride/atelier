// Generates build/icon.png (1024×1024, the Dock icon of dev runs) from assets/brand/app-icon.svg:
// `npx electron scripts/render-icon.cjs`. The Dock icon is only the front panel of the mark; inside the app the
// multi-panel mark (mark.svg) stays. The packaged app's icon is the Icon Composer package build/AppIcon.icon.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, 'assets/brand/app-icon.svg'), 'utf8');
const html = `<!doctype html><html><head><style>html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build/icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
