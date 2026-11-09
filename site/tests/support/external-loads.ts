/**
 * Absolute URLs a page or stylesheet makes the browser fetch from another origin (fonts and images are self-hosted, no
 * third-party requests): every srcset candidate, src of scripts/images/sources/iframes, link
 * hrefs, CSS url() and @import. Anchors are links the visitor clicks, not loads. URLs on `siteUrl` are allowed.
 */
export function externalLoads(text: string, siteUrl: string): string[] {
  const urls: string[] = [];
  for (const m of text.matchAll(/<(?:script|img|source|iframe)\b[^>]*?\ssrc="([^"]+)"/g)) urls.push(m[1]!);
  for (const m of text.matchAll(/\ssrcset="([^"]+)"/g)) for (const c of m[1]!.split(',')) urls.push(c.trim().split(/\s+/)[0]!);
  for (const m of text.matchAll(/<link\b[^>]*?\shref="([^"]+)"/g)) urls.push(m[1]!);
  for (const m of text.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) urls.push(m[1]!);
  for (const m of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) urls.push(m[1]!);
  const external = urls.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(siteUrl));
  return [...new Set(external)];
}

/**
 * What the dist guard rejects in a page or stylesheet: every external load, once the exact `beacon` tag (the Web
 * Analytics script with this site's token, or '' when the build has none) is set aside. The beacon URL in any other
 * form (another token, another element, a page that should have no beacon) still counts.
 */
export function disallowedLoads(text: string, siteUrl: string, beacon: string): string[] {
  return externalLoads(beacon ? text.split(beacon).join('') : text, siteUrl);
}
