export interface Release {
  version: string;
  beta: boolean;
  body: string;
}

// scripts/release.mjs marks a generated stub with this comment until someone edits it.
const STUB_MARKER = '<!-- Edit before releasing';

/** CHANGELOG.md → the published versions, newest first. */
export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  const parts = md.split(/^## +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const version = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (!body || body.startsWith('Not published') || body.includes(STUB_MARKER)) continue;
    out.push({ version, beta: /-beta\.\d+$/.test(version), body });
  }
  return out;
}
