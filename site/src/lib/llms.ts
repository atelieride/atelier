import { REPO_URL } from './repo';
import type { BentoItem, FeatureRowData, MacCell } from '../content/features';

/** /llms.txt (llmstxt.org): what Atelier is, for AI assistants, built from the site's own copy so it never drifts. */
export function llmsTxt(c: { siteUrl: string; minMacOS: string; windowsStoreUrl?: string | null; minWindows?: string }, d: { yourMac: MacCell[]; rows: FeatureRowData[]; bento: BentoItem[] }): string {
  const u = (p: string) => new URL(p, c.siteUrl).href;
  return [
    '# Atelier',
    '',
    `> A ${c.windowsStoreUrl ? 'macOS and Windows' : 'macOS'} desktop workbench for running many Claude Code sessions in parallel: live states, one key to the session waiting for you, every change traced to the session that made it, and the rest of the work beside them: editor, terminals, Git, Docker, Redis.`,
    '',
    `Free and open source (MIT, ${REPO_URL}). Apple Silicon, macOS ${c.minMacOS} or later${c.windowsStoreUrl ? `; Windows ${c.minWindows ?? '10'} or later (x64) from the Microsoft Store` : ''}. Atelier runs the real \`claude\` CLI; sessions keep running when the app quits or updates. Atelier is not affiliated with Anthropic.`,
    '',
    '## Highlights',
    ...d.yourMac.map((m) => `- ${m.title}: ${m.text}`),
    '',
    '## Features',
    ...d.rows.flatMap((r) => [`- ${r.eyebrow}: ${r.title} ${r.text}`, ...r.bullets.map((b) => `  - ${b}`)]),
    ...d.bento.map((b) => `- ${b.title}: ${b.text}`),
    '',
    '## Pages',
    `- [Features](${u('/features')}): every feature, with its shortcut and a screenshot`,
    `- [Download](${u('/download')}): the DMG and install notes${c.windowsStoreUrl ? ', the Microsoft Store link' : ''}`,
    `- [Changelog](${u('/changelog')}): what changed in each version`,
    `- [Support](${u('/support')}): pay what you want, once or monthly`,
    `- [Privacy](${u('/privacy')}): what the app and the website send`,
    `- [Source code](${REPO_URL}): the whole app and this website, MIT, on GitHub`,
    ''
  ].join('\n');
}
