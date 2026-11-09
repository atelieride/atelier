// Renders the DMG window's background from build/dmg/background.html into
// build/dmg/background.tiff, a Retina TIFF (1× and 2× pages, `tiffutil -cathidpicheck`) that Finder picks by display:
// `npx electron scripts/render-dmg-background.cjs [--preview <out.png>]`. --preview renders a 2× PNG with stand-ins for
// the icons Finder draws on top, to look at; it never touches the TIFF. Run once after editing the HTML; commit the TIFF.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = join(__dirname, '..');
const html = join(root, 'build/dmg/background.html');
const out = join(root, 'build/dmg/background.tiff');
// The window size is the HTML's --w/--h (a test ties them to DMG_WINDOW in release-ci.mjs).
const css = readFileSync(html, 'utf8');
const px = (name) => Number(new RegExp(`--${name}: (\\d+)px`).exec(css)?.[1]);
const W = px('w');
const H = px('h');
if (!(W > 0 && H > 0)) throw new Error(`${html} has no --w/--h size.`);
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0 && !process.argv[previewAt + 1]) throw new Error('--preview needs an output path (a .png).');
const preview = previewAt > 0 ? resolve(process.argv[previewAt + 1]) : null;

let win;
async function render(scale, query = '') {
  // Offscreen capture is 1 px per CSS px: a 2× page is the window at twice the size, zoomed 2×. One window for every
  // render: a second window in the same run fails to load the page.
  win ??= new BrowserWindow({ width: W, height: H, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.setContentSize(W * scale, H * scale);
  await win.loadURL(pathToFileURL(html).href + query);
  win.webContents.setZoomFactor(scale);
  // fonts.ready resolves even when a face fails (no npm ci): the background would silently use system fonts.
  const fonts = await win.webContents.executeJavaScript(`document.fonts.ready.then(() => [...document.fonts].map((f) => [f.family, f.status]))`);
  const missing = fonts.filter(([, status]) => status !== 'loaded').map(([family]) => family);
  if (!fonts.length || missing.length) throw new Error(`Brand fonts not loaded (${missing.join(', ') || 'none declared'}): run npm ci first.`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  if (width !== W * scale || height !== H * scale) throw new Error(`captured ${width}×${height}, expected ${W * scale}×${H * scale}`);
  return img.toPNG();
}

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    if (preview) {
      writeFileSync(preview, await render(2, '?preview'));
      console.log(`Preview: ${preview}`);
    } else {
      const tmp = mkdtempSync(join(tmpdir(), 'atl-dmg-bg-'));
      try {
        writeFileSync(join(tmp, 'background.png'), await render(1));
        writeFileSync(join(tmp, 'background@2x.png'), await render(2));
        execFileSync('/usr/bin/tiffutil', ['-cathidpicheck', join(tmp, 'background.png'), join(tmp, 'background@2x.png'), '-out', out]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      console.log(`Wrote ${out}`);
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
