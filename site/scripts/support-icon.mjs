// The image of the "Support Atelier" products on Polar: the checkout shows it as a small square thumbnail, so it is the
// palette's heart glyph (white heart on the brand gradient), full bleed (Polar rounds the corners). Polar's MCP cannot
// upload files: the maintainer uploads it from the dashboard. Run `node site/scripts/support-icon.mjs` (Chromium inside
// site/node_modules); writes assets/brand/support-icon.png.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(p, import.meta.url));
const theme = readFileSync(root('../../src/renderer/theme.css'), 'utf8');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>${theme}
html, body { width: 512px; height: 512px; margin: 0; overflow: hidden; }
body { background: var(--brand); display: grid; place-items: center; position: relative; }
/* A soft top light, as on the app icon. */
body::before { content: ''; position: absolute; inset: 0; background: radial-gradient(120% 80% at 30% 0%, rgba(255,255,255,.22), transparent 60%); }
svg { position: relative; filter: drop-shadow(0 18px 30px rgba(80,20,90,.45)); }
</style></head><body>
<svg width="380" height="380" viewBox="0 0 20 20"><path fill="#fff" d="M10 17.2s-7.2-4.2-7.2-9.3A3.9 3.9 0 0 1 10 5.9a3.9 3.9 0 0 1 7.2 2c0 5.1-7.2 9.3-7.2 9.3z"/></svg>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await page.setContent(html);
  writeFileSync(root('../../assets/brand/support-icon.png'), await page.screenshot());
} finally {
  await browser.close();
}
