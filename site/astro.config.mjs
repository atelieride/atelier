import { defineConfig } from 'astro/config';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prefetchLinks } from './src/lib/demo-prefetch.ts';

// The site imports the app's theme, brand assets and CHANGELOG.md from the repo root.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// The live demo's intent prefetch: the demo build (npm run build:demo, before this one) writes
// its entry and first-paint files to demo-app/manifest.json; the list is inlined into scripts/live-demo.ts, so the page
// makes no request for it. No demo built: an empty list, nothing prefetched (a click still opens the demo).
const manifest = new URL('./public/demo-app/manifest.json', import.meta.url);
const demoPrefetch = prefetchLinks(existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null);

export default defineConfig({
  site: 'https://useatelier.dev',
  output: 'static',
  // download.html, not download/index.html: Cloudflare Pages serves it at /download — the address the site links to
  // and names as canonical — instead of redirecting to /download/.
  build: { format: 'file' },
  vite: { server: { fs: { allow: [repoRoot] } }, define: { __DEMO_PREFETCH__: JSON.stringify(demoPrefetch) } }
});
