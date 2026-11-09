/** The header's search: the index built with the site, and its ranking. */
import { REPO_URL } from './repo';

export type SearchGroup = 'Pages' | 'Features' | 'Changelog' | 'And more' | 'Shortcuts';

export interface SearchItem {
  group: SearchGroup;
  label: string;
  hint: string;
  href: string;
  /** Shortcuts: the keys, drawn as caps. */
  keys?: string[];
  /** Changelog: the entry belongs to the latest version. */
  latest?: boolean;
  /** Words people search for that the label does not say (never shown, never underlined). */
  terms?: string[];
}

/** [start, end) of the match, for underlining. */
export type Range = [number, number];
export interface Hit { item: SearchItem; score: number; label: Range | null; hint: Range | null }
export interface ResultGroup { title: string; hits: Hit[] }

const ORDER: SearchGroup[] = ['Pages', 'Features', 'Changelog', 'And more', 'Shortcuts'];
const PER_GROUP = 6;

export function slug(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

/**
 * A release's rendered HTML → the same HTML with an anchor on every list item that starts with a bold title
 * (`v<version>-<slug>`, deduplicated), and those entries: the changelog page and the index come from this one pass.
 */
export function anchorReleaseHtml(html: string, version: string): { html: string; entries: { title: string; id: string }[] } {
  const entries: { title: string; id: string }[] = [];
  const used = new Set<string>();
  const out = html.replace(/<li>(\s*<strong>)([\s\S]*?)<\/strong>/g, (_, open: string, inner: string) => {
    const title = decode(inner.replace(/<[^>]*>/g, '')).trim();
    const base = `v${version}-${slug(title)}`;
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    entries.push({ title, id });
    return `<li id="${id}">${open}${inner}</strong>`;
  });
  return { html: out, entries };
}

export interface IndexSource {
  rows: { id: string; eyebrow: string; title: string }[];
  bento: { title: string; text: string }[];
  keys: { keys: string[]; label: string }[];
  /** Newest first. */
  releases: { version: string; entries: { title: string; id: string }[] }[];
}

export function buildIndex(src: IndexSource): SearchItem[] {
  const pages: [string, string][] = [['Overview', '/'], ['Features', '/features'], ['Changelog', '/changelog'], ['Download', '/download']];
  return [
    ...pages.map(([label, href]): SearchItem => ({ group: 'Pages', label, hint: href, href })),
    { group: 'Pages', label: 'Support Atelier', hint: '/support', href: '/support', terms: ['donate', 'donation', 'sponsor', 'tip', 'coffee', 'pay'] },
    { group: 'Pages', label: 'Source code', hint: 'GitHub', href: REPO_URL, terms: ['github', 'open source', 'mit', 'license', 'fork', 'repository', 'contribute', 'issues'] },
    ...src.rows.map((r): SearchItem => ({ group: 'Features', label: r.eyebrow, hint: r.title, href: `/features#${r.id}` })),
    ...src.releases.flatMap((r, i) => r.entries.map((e): SearchItem => ({ group: 'Changelog', label: e.title, hint: r.version, href: `/changelog#${e.id}`, latest: i === 0 }))),
    ...src.bento.map((b): SearchItem => ({ group: 'And more', label: b.title, hint: b.text, href: '/features#more' })),
    ...src.keys.map((k): SearchItem => ({ group: 'Shortcuts', label: k.label, hint: '', href: '/features#shortcuts', keys: k.keys }))
  ];
}

/** Prefix 4, start of a word 3, inside a word 2. */
function find(text: string, q: string): { score: number; range: Range } | null {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return null;
  const score = i === 0 ? 4 : /[\p{L}\p{N}]/u.test(text[i - 1]!) ? 2 : 3;
  return { score, range: [i, i + q.length] };
}

export function search(items: SearchItem[], query: string): ResultGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    const latest = items.find((i) => i.group === 'Changelog' && i.latest)?.hint;
    const pick = (g: SearchGroup, title: string = g, keep: (i: SearchItem) => boolean = () => true): ResultGroup =>
      ({ title, hits: items.filter((i) => i.group === g && keep(i)).map((item) => ({ item, score: 0, label: null, hint: null })) });
    return [pick('Pages'), pick('Features'), pick('Changelog', `New in ${latest}`, (i) => !!i.latest), pick('Shortcuts')]
      .filter((g) => g.hits.length);
  }
  const hits: Hit[] = [];
  for (const item of items) {
    const l = find(item.label, q), h = item.hint ? find(item.hint, q) : null;
    const t = !l && !h && item.terms?.some((w) => w.startsWith(q));
    if (!l && !h && !t) continue;
    hits.push({ item, score: Math.max(l ? l.score + 1 : 0, h ? h.score : 0, t ? 1 : 0), label: l?.range ?? null, hint: h?.range ?? null });
  }
  return ORDER
    .map((g) => ({ title: g as string, hits: hits.filter((x) => x.item.group === g).sort((a, b) => b.score - a.score).slice(0, PER_GROUP) }))
    .filter((g) => g.hits.length)
    .sort((a, b) => b.hits[0]!.score - a.hits[0]!.score);
}
