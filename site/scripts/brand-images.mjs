// Brand images the site serves as files: the Open Graph card and the apple-touch icon. Run once
// with `npm --prefix site run brand-images` (Chromium inside site/node_modules); the PNGs are committed. The raw colours
// below are the aurora tokens of src/styles/site.css: keep them in step.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(p, import.meta.url));
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(root(`../node_modules/@fontsource-variable/${pkg}/files/${file}`)).toString('base64')}`;
const theme = readFileSync(root('../../src/renderer/theme.css'), 'utf8');
const mark = readFileSync(root('../../assets/brand/mark.svg'), 'utf8');
// The Dock icon without macOS's margin (body 824 of 1024): iOS rounds the corners itself.
const icon = readFileSync(root('../../assets/brand/app-icon.svg'), 'utf8')
  .replace('width="1024" height="1024" viewBox="0 0 1024 1024"', 'width="180" height="180" viewBox="100 100 824 824"');

// The real app (the hero's screenshot) runs off the card's right edge, next to the headline. As the site since the
// quiet finish and the six-block home: a two-tone title, the window flat on a shade
// shadow and a hairline, no halos.
const shot = `data:image/png;base64,${readFileSync(root('../src/assets/shots/overview.png')).toString('base64')}`;

const og = `<!doctype html><html><head><meta charset="utf-8"><style>${theme}
@font-face { font-family: 'Instrument Sans'; src: url(${font('instrument-sans', 'instrument-sans-latin-wght-normal.woff2')}); font-weight: 400 700; }
@font-face { font-family: 'JetBrains Mono'; src: url(${font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}); font-weight: 100 800; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body { position: relative; font-family: var(--font); background: var(--bg-0); }
.copy { position: absolute; left: 72px; top: 0; bottom: 0; width: 500px; display: flex; flex-direction: column; justify-content: center; gap: 26px; z-index: 2; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 650; }
.brand svg { width: 52px; height: 52px; }
h1 { margin: 0; font-size: 58px; line-height: 1.04; letter-spacing: -.035em; font-weight: 700; }
/* site.css › --title-dim: the second line, between --text-3 and --text-4. */
.dim { color: color-mix(in srgb, var(--text-3) 50%, var(--text-4)); }
p { margin: 0; color: var(--text-3); font: 20px var(--mono); }
/* site.css › --shot-shadow: a shade below, a violet hairline around. */
.window { position: absolute; left: 616px; top: 118px; width: 900px; border-radius: 16px; overflow: hidden; background: var(--bg-1);
  box-shadow: 0 40px 100px -20px rgba(0,0,0,.8), 0 0 0 1px rgba(139,92,246,.18); }
.window img { display: block; width: 100%; }
/* macOS's traffic lights, at the shot's scale (Window.astro: 12 px lights, 20 px in, in the app's 45 px top bar). */
.lights { position: absolute; left: 14px; top: 12px; display: flex; gap: 6px; }
.lights i { width: 8.5px; height: 8.5px; border-radius: 50%; background: #2E2E4A; }
</style></head><body>
<div class="copy">
  <div class="brand">${mark}Atelier</div>
  <h1>Run many Claude Code sessions.<br><span class="dim">Never lose track.</span></h1>
  <p>The workbench for Claude Code</p>
</div>
<div class="window"><img src="${shot}" alt=""><span class="lights"><i></i><i></i><i></i></span></div>
</body></html>`;

// --in-process-gpu: on macOS 27 the headless shell's GPU process exits (playwright.config.ts).
const browser = await chromium.launch({ args: ['--in-process-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(og);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.window img').evaluate((img) => img.decode());
  writeFileSync(root('../public/og.png'), await page.screenshot());
  const iconPage = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await iconPage.setContent(`<!doctype html><html><body style="margin:0">${icon}</body></html>`);
  writeFileSync(root('../public/apple-touch-icon.png'), await iconPage.screenshot({ omitBackground: true }));
} finally {
  await browser.close();
}
