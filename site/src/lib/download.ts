export type Channel = 'stable' | 'beta';

export interface DownloadInfo {
  state: 'available' | 'coming-soon';
  url: string | null;
  version: string;
  channel: Channel;
  fileName: string;
  label: string;
}

// Only the versions scripts/release.mjs makes: X.Y.Z (stable) and X.Y.Z-beta.N.
const VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;

/**
 * The download the site offers: /download/mac (or /download/mac/beta), which functions/ redirects to
 * the newest DMG of the channel, so the button never goes stale between deploys.
 * While the app is not notarized, buttons outside /download (`direct` false) lead to /download, which explains
 * Gatekeeper's "Open Anyway" before the visitor gets the DMG.
 */
export function downloadInfo(c: { version: string; launched: boolean; notarized?: boolean; direct?: boolean }): DownloadInfo {
  if (!VERSION.test(c.version)) throw new Error(`Unexpected version "${c.version}": expected X.Y.Z or X.Y.Z-beta.N.`);
  const fileName = `Atelier-${c.version}-arm64.dmg`;
  const channel: Channel = c.version.includes('-beta.') ? 'beta' : 'stable';
  if (!c.launched) return { state: 'coming-soon', url: null, version: c.version, channel, fileName, label: 'Coming soon' };
  const dmg = channel === 'beta' ? '/download/mac/beta' : '/download/mac';
  const url = c.notarized === false && !c.direct ? '/download' : dmg;
  return { state: 'available', url, version: c.version, channel, fileName, label: 'Download for macOS' };
}
