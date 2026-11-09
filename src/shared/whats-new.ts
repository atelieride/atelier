// "What's new" after an update: CHANGELOG.md's sections between the previous launch and
// the running version, and the little inline Markdown its bullets use. Pure: the renderer turns the tokens into React
// nodes (never HTML).

import { compareSemver, parseSemver } from './update-feed';

export interface ChangelogSection { version: string; body: string }

/** Versions shown in the sheet at most; the rest are counted and left to the full changelog online. */
export const MAX_WHATS_NEW = 6;

/**
 * The full changelog, on the website (it follows CHANGELOG.md once deployed). Here, not in the sheet: Settings links it
 * too, and the sheet (CHANGELOG.md inside) loads only when it opens.
 */
export const CHANGELOG_URL = 'https://useatelier.dev/changelog';

/** Every "## <version>" section, in file order, its body trimmed. Headings that aren't versions are body text. */
export function changelogSections(md: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let cur: { version: string; lines: string[] } | null = null;
  const flush = () => { if (cur) out.push({ version: cur.version, body: cur.lines.join('\n').trim() }); };
  for (const line of md.split('\n')) {
    const head = /^##\s+(\S+)\s*$/.exec(line);
    if (head && parseSemver(head[1]!)) { flush(); cur = { version: head[1]!, lines: [] }; continue; }
    cur?.lines.push(line);
  }
  flush();
  return out;
}

/**
 * The sections newer than `since` (the previous launch's version) up to `current`, newest first, at most `max`; `more`
 * counts the older ones left out. Without `since` (opened from the menu): the running version's section alone.
 */
export function whatsNewSections(md: string, since: string | null, current: string, max = MAX_WHATS_NEW): { sections: ChangelogSection[]; more: number } {
  const all = changelogSections(md)
    .filter((s) => compareSemver(s.version, current) <= 0 && (since === null ? s.version === current : compareSemver(s.version, since) > 0))
    .sort((a, b) => compareSemver(b.version, a.version));
  return { sections: all.slice(0, max), more: Math.max(0, all.length - max) };
}

export type InlineToken = { kind: 'text' | 'bold' | 'code'; text: string };

/** `**bold**` and `` `code` `` spans; anything else (an unclosed marker, HTML) stays plain text. */
export function inlineMarkdown(s: string): InlineToken[] {
  const out: InlineToken[] = [];
  const re = /\*\*([^*]+?)\*\*|`([^`]+)`/g;
  let last = 0;
  const text = (t: string) => { if (!t) return; const prev = out.at(-1); if (prev?.kind === 'text') prev.text += t; else out.push({ kind: 'text', text: t }); };
  for (let m = re.exec(s); m; m = re.exec(s)) {
    text(s.slice(last, m.index));
    out.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : { kind: 'code', text: m[2]! });
    last = m.index + m[0].length;
  }
  text(s.slice(last));
  return out;
}

export type NoteBlock = { kind: 'h' | 'p'; text: string } | { kind: 'ul'; items: string[] };

/**
 * Release notes as blocks: headings, paragraphs (their lines joined) and bullet lists — a bullet's wrapped, indented
 * lines belong to it (CHANGELOG.md wraps at 120 columns).
 */
export function noteBlocks(body: string): NoteBlock[] {
  const out: NoteBlock[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const endPara = () => { if (para.length) out.push({ kind: 'p', text: para.join(' ') }); para = []; };
  const endList = () => { if (list) out.push({ kind: 'ul', items: list }); list = null; };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet) { endPara(); (list ??= []).push(bullet[1]!); }
    else if (head) { endPara(); endList(); out.push({ kind: 'h', text: head[1]! }); }
    else if (!line.trim()) { endPara(); endList(); }
    else if (list && /^\s+/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else { endList(); para.push(line.trim()); }
  }
  endPara();
  endList();
  return out;
}

/** How many changes a section lists (its bullets), shown on a collapsed version. */
export function changeCount(body: string): number {
  return noteBlocks(body).reduce((n, b) => n + (b.kind === 'ul' ? b.items.length : 0), 0);
}
