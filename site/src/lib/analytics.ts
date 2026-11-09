/** Cloudflare Web Analytics: no cookies; the only script from another origin. */
export const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

/** The beacon tag, or '' without a token or when the build opts out (dev server, e2e builds).
 *  Its SPA tracking is on by default (it follows history.pushState and popstate; `"spa": false` would turn it off,
 *  developers.cloudflare.com/web-analytics/get-started/web-analytics-spa/): opening the live demo from a page moves the
 * URL to /demo with pushState, so every opening counts as a page view of /demo, like the direct link. Nothing else is
 * collected for it. */
export function beaconTag(token: string | null, enabled: boolean): string {
  if (!token || !enabled) return '';
  if (!/^[0-9a-f]{32}$/.test(token)) throw new Error(`Unexpected Web Analytics token "${token}": expected 32 hex characters.`);
  return `<script defer src="${BEACON_SRC}" data-cf-beacon='${JSON.stringify({ token })}'></script>`;
}
