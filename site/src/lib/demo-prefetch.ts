import { DEMO_BASE, isDemoManifest } from '../../../src/demo/protocol';

// Build time only (astro.config.mjs reads demo-app/manifest.json and inlines this list into scripts/live-demo.ts through
// `define`): the page never fetches the manifest, and never ships the code that checks it.

export interface PrefetchLink { href: string; as: 'script' | 'style' | 'font' | null; crossorigin: boolean }

/** The links an intent (hover, focus) adds so a click finds the demo's first paint in the HTTP cache: the manifest's
 *  entry, then its first-paint files, then its fonts, once each. A missing or malformed manifest (no demo built) prefetches nothing. */
export function prefetchLinks(manifest: unknown): PrefetchLink[] {
  if (!isDemoManifest(manifest)) return [];
  return [...new Set([manifest.entry, ...manifest.firstPaint, ...(manifest.fonts ?? [])])].map((p) => {
    const ext = p.slice(p.lastIndexOf('.') + 1);
    const as = ext === 'js' || ext === 'mjs' ? 'script' : ext === 'css' ? 'style' : /^(woff2?|ttf|otf)$/.test(ext) ? 'font' : null;
    // Fonts are fetched in CORS mode even same-origin; a no-cors prefetch of one would sit unused next to it.
    return { href: `${DEMO_BASE}${p}`, as, crossorigin: as === 'font' };
  });
}
