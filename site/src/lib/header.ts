/** The header in one row, as a path: what it marks and what its path shows. */

/** The pages the header links, besides the home (the path itself): the download is the header's button, not a page. */
export type PageId = 'features' | 'changelog';

/** A pathname as Cloudflare Pages may serve it (`/features`, `/features.html`, `/features/`) → its first segment. */
const first = (pathname: string) => pathname.replace(/\/index(\.html)?$/, '/').replace(/\.html$/, '').split('/').filter(Boolean)[0] ?? '';

/** The page link marked with aria-current on this page, if any. */
export function activePage(pathname: string): PageId | null {
  const s = first(pathname);
  return s === 'features' || s === 'changelog' ? s : null;
}

/** The segment after `~/useatelier.dev`: the page's own name, none on the home and on the 404 (not a real page). */
export function pathSegment(pathname: string): string | null {
  const s = first(pathname);
  return s && s !== '404' ? s : null;
}
