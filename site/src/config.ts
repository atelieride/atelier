import pkg from '../../package.json';
import { REPO_URL } from './lib/repo';

/** The site's single source of truth. */
export const config = {
  /** The app version the site offers: the repo's package.json (the release script bumps it). */
  version: pkg.version as string,
  /** false: every page is noindex and download buttons say "Coming soon". */
  launched: true,
  /** false: /download explains Gatekeeper's "Open Anyway". */
  notarized: true,
  /** As README.md states and the built app's LSMinimumSystemVersion (13.0) says. */
  minMacOS: '13 Ventura',
  /** The Microsoft Store listing of the Windows app (product 9N9FX0BQ20HF, "Atelier IDE"); null: Windows shows "Soon". */
  windowsStoreUrl: 'https://apps.microsoft.com/detail/9N9FX0BQ20HF' as string | null,
  /** As build/appx/AppxManifest.xml's MinVersion (10.0.19041) says. */
  minWindows: '10 (2004)',
  author: 'Francesco Musso',
  /** The public repository: the code (MIT), the releases, the issues. */
  githubUrl: REPO_URL,
  contactEmail: 'hello@useatelier.dev',
  /** Polar checkout link (organization `useatelier`): pay what you want, once or monthly; returns to /support?thanks=1. Dark, like the site (otherwise it follows the system). */
  supportUrl: 'https://buy.polar.sh/polar_cl_Sz6wcWIfm9ee2VgYUyMmYxfJQs0NsgtyCnyG42tHgmg?theme=dark',
  /** Cloudflare Web Analytics site token (public by design; manual snippet, automatic injection off). null: no beacon. */
  webAnalyticsToken: '396e74f7f12b4e2586473c7c8f8a94a1' as string | null,
  siteUrl: 'https://useatelier.dev',
  /** Browser UI colour (= --bg-0 in theme.css): meta tags cannot read CSS. */
  themeColor: '#08080F'
} as const;
