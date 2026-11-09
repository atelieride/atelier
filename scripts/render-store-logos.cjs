// Generates the MSIX logos (build/appx/assets, committed) from assets/brand/app-icon.svg:
// `npx electron scripts/render-store-logos.cjs`. Each image is drawn by Chromium at its own pixel size (no downscaled
// bitmap), the tile centred on a whole-pixel margin and transparent around it. Qualifiers as makepri indexes them:
// scale-100/200/400 for every logo, targetsize-16…256 plain and altform-unplated for
// Square44x44Logo (taskbar, Start, File Explorer). Square150x150Logo (Windows 10's medium tile, drawn on a plate) keeps
// a wide margin, as Windows' own tiles do.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const out = join(root, 'build/appx/assets');
// Only the tile (the body of the macOS grid: 824 at 100,100); the margin is added per image.
const svg = readFileSync(join(root, 'assets/brand/app-icon.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/width="1024" height="1024" viewBox="0 0 1024 1024"/, 'width="100%" height="100%" viewBox="100 100 824 824"');

// At 16 and 24 px the glyph's shadow and narrow apex blur into an "A" (the mark has no crossbar): small images draw it
// without the shadow, with wider legs and a stroke closer to whole pixels.
const small = svg
  .replace(/ filter="url\(#shadow\)"/, '')
  .replace('d="M362 698 L512 326 L662 698" stroke="#FFFFFF" stroke-width="80" stroke-linecap="round" stroke-linejoin="round"',
    'd="M300 730 L512 280 L724 730" stroke="#FFFFFF" stroke-width="84" stroke-linecap="butt" stroke-linejoin="miter"');
if (small === svg) throw new Error('app-icon.svg changed: update the small glyph');

/** Margin around the tile, as a share of the image's side. */
const ICON = 0.0625;
const TILE = 0.2;

function images() {
  const list = [];
  const add = (file, size, margin) => list.push({ file, size, margin: Math.round(size * margin) });
  for (const s of [100, 200, 400]) {
    add(`StoreLogo.scale-${s}.png`, (50 * s) / 100, ICON);
    add(`Square44x44Logo.scale-${s}.png`, (44 * s) / 100, ICON);
    add(`Square150x150Logo.scale-${s}.png`, (150 * s) / 100, TILE);
  }
  for (const t of [16, 24, 32, 48, 256]) {
    add(`Square44x44Logo.targetsize-${t}.png`, t, ICON);
    add(`Square44x44Logo.targetsize-${t}_altform-unplated.png`, t, ICON);
  }
  return list;
}

const page = ({ size, margin }) => `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}` +
  `div{position:absolute;left:${margin}px;top:${margin}px;width:${size - 2 * margin}px;height:${size - 2 * margin}px}svg{display:block}</style></head>` +
  `<body><div>${size <= 24 ? small : svg}</div></body></html>`;

// One CSS pixel per image pixel, whatever the screen of the machine rendering them.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 640, height: 640, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (f.endsWith('.png')) rmSync(join(out, f));
  for (const img of images()) {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(img)));
    await new Promise((r) => setTimeout(r, 150));
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: img.size, height: img.size });
    const { width, height } = shot.getSize();
    if (width !== img.size || height !== img.size) throw new Error(`${img.file}: captured ${width}×${height}, not ${img.size}`);
    writeFileSync(join(out, img.file), shot.toPNG());
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
