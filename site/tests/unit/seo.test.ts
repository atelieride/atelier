import { expect, test } from 'vitest';
import { PAGES, jsonLdScript, robotsTxt, sitemapXml, softwareJsonLd } from '../../src/lib/seo';

const site = { siteUrl: 'https://useatelier.dev' };

test('the sitemap lists every real page at the address it is served at', () => {
  const xml = sitemapXml(site);
  expect(PAGES).toEqual(['/', '/features', '/download', '/changelog', '/support', '/privacy', '/demo']);
  for (const p of PAGES) expect(xml).toContain(`<loc>https://useatelier.dev${p}</loc>`);
  // The demo's own files are never a page to index: only /demo, the page that frames them.
  expect(xml).not.toContain('demo-app');
  expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
});

test('robots.txt lets crawlers in once launched (never into the demo build) and points at the sitemap; before launch it keeps them out', () => {
  expect(robotsTxt({ ...site, launched: true })).toBe('User-agent: *\nAllow: /\nDisallow: /demo-app/\n\nSitemap: https://useatelier.dev/sitemap.xml\n');
  expect(robotsTxt({ ...site, launched: false })).toBe('User-agent: *\nDisallow: /\n');
});

test('SoftwareApplication: free, macOS, the channel\'s download, no invented ratings', () => {
  const ld = softwareJsonLd({ siteUrl: 'https://useatelier.dev', version: '0.3.0', minMacOS: '13 Ventura', author: 'Francesco Musso', description: 'D' });
  expect(ld).toEqual({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Atelier', url: 'https://useatelier.dev/',
    description: 'D', applicationCategory: 'DeveloperApplication', operatingSystem: 'macOS 13 or later', softwareVersion: '0.3.0',
    downloadUrl: 'https://useatelier.dev/download/mac', image: 'https://useatelier.dev/og.png',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, author: { '@type': 'Person', name: 'Francesco Musso' }
  });
  expect(softwareJsonLd({ siteUrl: 'https://useatelier.dev', version: '0.3.0-beta.1', minMacOS: '13 Ventura', author: 'A', description: 'D' }).downloadUrl)
    .toBe('https://useatelier.dev/download/mac/beta');
});

test('SoftwareApplication with the Windows app in the Store: both systems', () => {
  expect(softwareJsonLd({ siteUrl: 'https://useatelier.dev', version: '0.3.0', minMacOS: '13 Ventura', author: 'A', description: 'D', windowsStoreUrl: 'https://apps.microsoft.com/detail/X' }).operatingSystem)
    .toBe('macOS 13 or later, Windows 10 or later');
});

test('JSON-LD cannot close its script tag', () => {
  expect(jsonLdScript({ a: '</script><script>alert(1)</script>' })).toBe('{"a":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}');
});
