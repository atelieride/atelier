// Markdown → sanitized hast: micromark + GFM + YAML front matter → mdast → hast (raw HTML
// parsed by parse5) → GitHub's sanitize schema. The tree is rendered as React elements: no HTML string ever reaches the
// DOM. Every block keeps its source lines in `data-src`, headings their GitHub slug in `data-slug`.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { toHast } from 'mdast-util-to-hast';
import { raw } from 'hast-util-raw';
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import type { Blockquote, Nodes as MdNodes, Root as MdRoot } from 'mdast';
import { parseFrontMatter, slugger, type FrontPair } from './text';

/** Past this many characters the preview gives up (the editor still shows the file). */
export const MAX_PREVIEW_CHARS = 2 * 1024 * 1024;

export interface FrontMatter { pairs: FrontPair[] | null; raw: string; start: number; end: number }
export interface Rendered {
  tree: Root;
  /** Tag names of the raw HTML elements the allow-list dropped, first-seen order, once each. */
  dropped: string[];
  /** How many elements that is. */
  droppedCount: number;
  frontMatter: FrontMatter | null;
}

const ALERTS = new Set(['note', 'tip', 'important', 'warning', 'caution']);
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'div', 'ul', 'ol', 'li', 'table', 'tr', 'pre', 'hr', 'details', 'dl', 'section']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

// GitHub's schema, minus what a README could use against the app: <picture>/<source srcset> would load images past the
// project-confined loader, tabindex/accesskey would take over the window's keyboard. dataSrc and dataAlert pass only to
// be checked after sanitizing: the parser's own carry a per-render token raw HTML can't know.
const SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((n) => n !== 'picture' && n !== 'source'),
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []).filter((a) => a !== 'tabIndex' && a !== 'accessKey'), 'dataSrc'],
    div: [...(defaultSchema.attributes?.div ?? []), 'dataAlert']
  }
};
const ALLOWED = new Set(SCHEMA.tagNames ?? []);

type HNode = Root | RootContent | ElementContent;
const walk = (n: HNode, visit: (e: Element) => void): void => {
  if (n.type === 'element') visit(n);
  if ('children' in n) for (const c of n.children) walk(c, visit);
};

/** GitHub alerts: a quote starting with `[!NOTE]` (TIP, IMPORTANT, WARNING, CAUTION) becomes a tagged box. */
function markAlerts(node: MdNodes, token: string): void {
  if (node.type === 'blockquote') {
    const kind = alertOf(node);
    if (kind) node.data = { ...node.data, hName: 'div', hProperties: { ...node.data?.hProperties, dataAlert: `${token}:${kind}` } };
  }
  if ('children' in node) for (const c of node.children) markAlerts(c as MdNodes, token);
}

/** The parser's own value of a marker attribute (token checked and removed); null for a forged or missing one. */
const own = (v: unknown, token: string): string | null => (typeof v === 'string' && v.startsWith(`${token}:`) ? v.slice(token.length + 1) : null);

function alertOf(q: Blockquote): string | null {
  const p = q.children[0];
  const first = p?.type === 'paragraph' ? p.children[0] : undefined;
  if (first?.type !== 'text') return null;
  const m = /^\[!(\w+)\][ \t]*(?:\n|$)?/.exec(first.value);
  const kind = m?.[1]?.toLowerCase();
  if (!m || !kind || !ALERTS.has(kind)) return null;
  first.value = first.value.slice(m[0].length);
  if (!first.value && p?.type === 'paragraph') {
    p.children.shift();
    // A soft break after the marker would start the text with an empty line.
    if (p.children[0]?.type === 'break') p.children.shift();
    if (!p.children.length) q.children.shift();
  }
  return kind;
}

/** Plain text of an element (headings, outline). */
export const textOf = (n: HNode): string => n.type === 'text' ? n.value : 'children' in n ? n.children.map((c) => textOf(c)).join('') : '';

export function renderMarkdown(text: string): Rendered {
  const md: MdRoot = fromMarkdown(text, {
    extensions: [gfm(), frontmatter(['yaml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml'])]
  });
  let frontMatter: FrontMatter | null = null;
  const head = md.children[0];
  if (head?.type === 'yaml') {
    frontMatter = { pairs: parseFrontMatter(head.value), raw: head.value, start: head.position?.start.line ?? 1, end: head.position?.end.line ?? 1 };
    md.children.shift();
  }
  const token = globalThis.crypto.randomUUID();
  markAlerts(md, token);
  const converted = toHast(md, { allowDangerousHtml: true }) as Root;
  // Source lines on every block that has a position (generated wrappers such as thead have none), before parse5 runs:
  // hast-util-raw keeps attributes but not positions.
  walk(converted, (e) => {
    const pos = e.position;
    if (pos && BLOCK_TAGS.has(e.tagName)) e.properties.dataSrc = `${token}:${pos.start.line}-${pos.end.line}`;
  });
  const parsed = raw(converted) as Root;
  const dropped: string[] = [];
  let droppedCount = 0;
  walk(parsed, (e) => { if (ALLOWED.has(e.tagName)) return; droppedCount++; if (!dropped.includes(e.tagName)) dropped.push(e.tagName); });
  const tree = sanitize(parsed, SCHEMA) as Root;
  // Markers: the parser's kept (token removed), raw HTML's dropped; code blocks numbered for the highlighter's cap.
  let block = 0;
  walk(tree, (e) => {
    const src = own(e.properties.dataSrc, token);
    if (src) e.properties.dataSrc = src; else delete e.properties.dataSrc;
    const alert = own(e.properties.dataAlert, token);
    if (alert && ALERTS.has(alert)) e.properties.dataAlert = alert; else delete e.properties.dataAlert;
    if (e.tagName === 'pre' && src) e.properties.dataBlock = block++;
  });
  // Footnote ids come prefixed from mdast-util-to-hast and sanitize prefixes every id again: once is what the links say.
  walk(tree, (e) => {
    if (typeof e.properties.id === 'string') e.properties.id = e.properties.id.replace(/^(user-content-)+/, 'user-content-');
  });
  const slug = slugger();
  walk(tree, (e) => { if (HEADINGS.has(e.tagName)) e.properties.dataSlug = slug(textOf(e).trim()); });
  return { tree, dropped, droppedCount, frontMatter };
}

export interface Heading { level: number; text: string; slug: string; line: number }

/** The outline: h2 and h3 (h1s when there is no h2), only headings written in the file (not generated ones). */
export function outlineOf(tree: Root): Heading[] {
  const all: Heading[] = [];
  walk(tree, (e) => {
    if (!HEADINGS.has(e.tagName) || typeof e.properties.dataSrc !== 'string') return;
    all.push({ level: Number(e.tagName[1]), text: textOf(e).trim(), slug: String(e.properties.dataSlug), line: Number(e.properties.dataSrc.split('-')[0]) });
  });
  const levels = all.some((h) => h.level === 2) ? [2, 3] : [1];
  return all.filter((h) => levels.includes(h.level));
}

/** The page's readable text (code blocks left out), for the word count. */
export function plainText(tree: Root): string {
  const parts: string[] = [];
  const go = (n: HNode): void => {
    if (n.type === 'text') { parts.push(n.value); return; }
    if (n.type === 'element' && n.tagName === 'pre') return;
    if ('children' in n) for (const c of n.children) go(c);
    if (n.type === 'element' && BLOCK_TAGS.has(n.tagName)) parts.push('\n');
  };
  go(tree);
  return parts.join('');
}
