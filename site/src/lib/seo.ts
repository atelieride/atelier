/** The site's real pages, as Cloudflare Pages serves them (the canonical URLs, Base.astro). /demo is one (the live
 *  demo's direct link): indexed once launched like the rest; the demo build under /demo-app/ never. */
export const PAGES = ['/', '/features', '/download', '/changelog', '/support', '/privacy', '/demo'] as const;

export function sitemapXml(c: { siteUrl: string }): string {
  const urls = PAGES.map((p) => `  <url><loc>${new URL(p, c.siteUrl).href}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Before launch the pages are noindex as well (Base.astro); robots.txt keeps crawlers out altogether. After launch
 *  the demo build stays out (its index.html is noindex too): it is the app's bundle, not content, and /demo frames it. */
export function robotsTxt(c: { siteUrl: string; launched: boolean }): string {
  if (!c.launched) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\nDisallow: /demo-app/\n\nSitemap: ${new URL('/sitemap.xml', c.siteUrl).href}\n`;
}

/** The app as schema.org sees it: on the home and download pages. */
export function softwareJsonLd(c: { siteUrl: string; version: string; minMacOS: string; author: string; description: string; windowsStoreUrl?: string | null }): Record<string, unknown> {
  const u = (p: string) => new URL(p, c.siteUrl).href;
  return {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Atelier', url: u('/'),
    description: c.description, applicationCategory: 'DeveloperApplication', operatingSystem: c.windowsStoreUrl ? `macOS ${c.minMacOS.split(' ')[0]} or later, Windows 10 or later` : `macOS ${c.minMacOS.split(' ')[0]} or later`,
    softwareVersion: c.version, downloadUrl: u(c.version.includes('-beta.') ? '/download/mac/beta' : '/download/mac'), image: u('/og.png'),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, author: { '@type': 'Person', name: c.author }
  };
}

/** JSON for a <script type="application/ld+json">: `<` escaped, so no string can close the tag. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
