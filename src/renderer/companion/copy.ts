// Ask's formatted copies: every copy carries clean HTML, which ClickUp, Word and the like
// paste with its bold, lists and code, and plain text. Chromium's own copy would carry the dark theme's computed colors
// (light grey on Word's white page), so Ask writes its own: only p, br, strong, em, code, a (http and https only),
// ol/ul/li, never a class or a style. Pure: a selection arrives as plain nodes (copy-dom.ts turns a Range into them), an
// answer as its Markdown.
import { parseAnswer, parseInline, type AnswerBlock, type Inline } from '@shared/companion/answer';
import { isSafeUrl } from '@shared/links';
import type { PointStatus, Thread, ThreadItem } from '@shared/companion/types';
import { t } from '../i18n/en';
import { itemHeading, pointTimes, threadMarkdown } from './view';

/** A selected node: its text, or an element with the attributes the copy reads (`data-copy*`, `aria-hidden`, numbers). */
export type CopyNode = string | CopyEl;
export interface CopyEl { tag: string; attrs: Record<string, string>; kids: CopyNode[] }
export interface Copied { html: string; text: string }

/** A Catch me up point's glyph in a copy (the card draws them: green check, sky half-ring, empty ring, amber ?). */
export const POINT_GLYPH: Record<PointStatus, string> = { done: '✓', in_progress: '◐', not_started: '○', unclear: '?' };

// --- the model both flavours are written from -------------------------------------------------------------------------

/** A run's formatting: bold, italic, code, and the URL of the link it is part of. */
interface Fmt { b: boolean; i: boolean; code: boolean; a: string | null }
type Run = (Fmt & { s: string }) | 'br';
type ListItem = { value: number | null; runs: Run[] };
type Block = { k: 'p'; runs: Run[] } | { k: 'list'; ordered: boolean; start: number | null; items: ListItem[] };

const PLAIN: Fmt = { b: false, i: false, code: false, a: null };
const sameFmt = (a: Fmt, b: Fmt) => a.b === b.b && a.i === b.i && a.code === b.code && a.a === b.a;
const endsBlank = (runs: Run[]) => { const last = runs.at(-1); return last === undefined || last === 'br' || /\s$/.test(last.s); };

/** Text into a run list: whitespace collapses as the page shows it (pre: kept, its line breaks become breaks). */
function pushText(runs: Run[], s: string, f: Fmt, pre = false): void {
  if (pre) {
    s.split('\n').forEach((line, k) => { if (k > 0) runs.push('br'); if (line) pushRun(runs, line, f); });
    return;
  }
  let v = s.replace(/\s+/g, ' ');
  if (v.startsWith(' ') && endsBlank(runs)) v = v.slice(1);
  if (v) pushRun(runs, v, f);
}

function pushRun(runs: Run[], s: string, f: Fmt): void {
  const last = runs.at(-1);
  if (last !== undefined && last !== 'br' && sameFmt(last, f)) last.s += s;
  else runs.push({ s, b: f.b, i: f.i, code: f.code, a: f.a });
}

/** A paragraph's or item's runs without the blank they end with; null when nothing is left. */
function settled(runs: Run[]): Run[] | null {
  const out = [...runs];
  while (out.length) {
    const last = out.at(-1)!;
    if (last === 'br') { out.pop(); continue; }
    const s = last.s.replace(/\s+$/, '');
    if (s) { out[out.length - 1] = { ...last, s }; break; }
    out.pop();
  }
  return out.some((r) => r !== 'br' && r.s.trim()) ? out : null;
}

const count = (v: string | undefined): number | null => (v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : null);

// --- a selection's nodes ----------------------------------------------------------------------------------------------

const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'blockquote', 'pre', 'details', 'summary', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const HEADINGS = /^h[1-6]$/;
const DROPPED = new Set(['svg', 'script', 'style', 'template', 'img', 'input', 'textarea', 'select']);

interface Ctx extends Fmt { pre: boolean }

/** What an element copies as: null when it stays out (chrome, hidden glyphs, controls). */
function resolve(n: CopyEl, c: Ctx): { tag: string; kids: CopyNode[]; c: Ctx; before: string | null } | null {
  const a = n.attrs;
  const tag = n.tag.toLowerCase();
  if (a['data-copy'] === 'skip' || a['aria-hidden'] === 'true' || DROPPED.has(tag)) return null;
  const text = a['data-copy-text'];
  // A control copies only when it says what as: its text (a file chip's reference) or its content (a Detail's title).
  if (tag === 'button' && text === undefined && a['data-copy'] !== 'keep') return null;
  const wrap = a['data-copy-wrap'];
  const next: Ctx = {
    b: c.b || tag === 'strong' || tag === 'b' || HEADINGS.test(tag) || wrap === 'strong',
    i: c.i || tag === 'em' || tag === 'i' || wrap === 'em',
    code: c.code || tag === 'code' || wrap === 'code',
    // A link copies as one only to an http(s) URL, as the browser reads it; any other is its text.
    a: tag === 'a' ? (a.href !== undefined && isSafeUrl(a.href) ? new URL(a.href.trim()).href : null) : c.a,
    pre: c.pre || a['data-copy-pre'] !== undefined
  };
  return { tag, kids: text !== undefined ? [text] : n.kids, c: next, before: a['data-copy-before'] ?? null };
}

function hasText(nodes: readonly CopyNode[], c: Ctx): boolean {
  return nodes.some((n) => {
    if (typeof n === 'string') return n.trim() !== '';
    const r = resolve(n, c);
    return r !== null && hasText(r.kids, r.c);
  });
}

/** Everything inline (an item's content): a block inside only keeps its words apart. */
function inlineRuns(nodes: readonly CopyNode[], c: Ctx, runs: Run[]): void {
  for (const n of nodes) {
    if (typeof n === 'string') { pushText(runs, n, c, c.pre); continue; }
    const r = resolve(n, c);
    if (!r) continue;
    if (r.tag === 'br') { runs.push('br'); continue; }
    const block = BLOCKS.has(r.tag) || r.tag === 'li' || r.tag === 'ol' || r.tag === 'ul';
    if (block) pushText(runs, ' ', c);
    if (r.before !== null && hasText(r.kids, r.c)) pushText(runs, r.before, c);
    inlineRuns(r.kids, r.c, runs);
    if (block) pushText(runs, ' ', c);
  }
}

function listOf(n: CopyEl, kids: readonly CopyNode[], c: Ctx, ordered: boolean): Block {
  const items: ListItem[] = [];
  for (const k of kids) {
    if (typeof k === 'string') { if (k.trim()) items.push({ value: null, runs: runsOf([k], c) }); continue; }
    const r = resolve(k, c);
    if (!r) continue;
    const runs: Run[] = [];
    if (r.before !== null && hasText(r.kids, r.c)) pushText(runs, r.before, c);
    inlineRuns(r.kids, r.c, runs);
    const done = settled(runs);
    if (done) items.push({ value: r.tag === 'li' ? count(k.attrs.value) : null, runs: done });
  }
  return { k: 'list', ordered, start: ordered ? count(n.attrs.start) : null, items };
}

function runsOf(nodes: readonly CopyNode[], c: Ctx): Run[] {
  const runs: Run[] = [];
  inlineRuns(nodes, c, runs);
  return runs;
}

/** Block-level content: loose inline content between blocks is a paragraph of its own. */
function blocksOf(nodes: readonly CopyNode[], c: Ctx, out: Block[]): void {
  let para: Run[] = [];
  const flush = () => { const done = settled(para); if (done) out.push({ k: 'p', runs: done }); para = []; };
  // Loose list items (a selection of a list's items arrives without its list): one list around them.
  let loose: CopyNode[] = [];
  const flushLoose = () => { if (loose.length) { const b = listOf({ tag: 'ul', attrs: {}, kids: [] }, loose, c, false); if (b.k === 'list' && b.items.length) out.push(b); loose = []; } };
  for (const n of nodes) {
    if (typeof n === 'string') { if (loose.length && !n.trim()) continue; flushLoose(); pushText(para, n, c, c.pre); continue; }
    const r = resolve(n, c);
    if (!r) continue;
    if (r.tag === 'li') { flush(); loose.push(n); continue; }
    flushLoose();
    if (r.tag === 'br') { para.push('br'); continue; }
    if (r.tag === 'ol' || r.tag === 'ul') {
      flush();
      const b = listOf(n, r.kids, r.c, r.tag === 'ol');
      if (b.k === 'list' && b.items.length) out.push(b);
      continue;
    }
    if (BLOCKS.has(r.tag)) {
      flush();
      if (r.before !== null && hasText(r.kids, r.c)) pushText(para, r.before, c);
      blocksOf(r.kids, r.c, out);
      continue;
    }
    if (r.before !== null && hasText(r.kids, r.c)) pushText(para, r.before, c);
    // An inline element holding blocks (a span around paragraphs, rare): its blocks still come apart.
    if (holdsBlocks(r.kids)) { flush(); blocksOf(r.kids, r.c, out); continue; }
    inlineRuns(r.kids, r.c, para);
  }
  flushLoose();
  flush();
}

const holdsBlocks = (nodes: readonly CopyNode[]) => nodes.some((n) => typeof n !== 'string' && (BLOCKS.has(n.tag.toLowerCase()) || /^(?:li|ol|ul)$/.test(n.tag.toLowerCase())));

/**
 * A selection: its nodes (the Range's contents), inside the formatting it sits in (`wrap`, outermost first: a bold run
 * a few words were picked from, the list the picked items belong to).
 */
export function copyOf(nodes: readonly CopyNode[], wrap: readonly CopyEl[] = []): Copied {
  let tree: CopyNode[] = [...nodes];
  for (let k = wrap.length - 1; k >= 0; k--) tree = [{ ...wrap[k]!, kids: tree }];
  const blocks: Block[] = [];
  blocksOf(tree, { ...PLAIN, pre: false }, blocks);
  return written(blocks, textOf(blocks));
}

// --- an answer, a thread ---------------------------------------------------------------------------------------------

function inlineModel(inline: readonly Inline[], runs: Run[], base: Fmt = PLAIN): Run[] {
  for (const i of inline) {
    switch (i.t) {
      case 'text': pushText(runs, i.s, base); break;
      case 'bold': pushText(runs, i.s, { ...base, b: true }); break;
      case 'italic': pushText(runs, i.s, { ...base, i: true }); break;
      case 'code': pushRun(runs, i.s, { ...base, code: true }); break;
      case 'file': pushRun(runs, i.raw, { ...base, code: true }); break;
      case 'link': inlineModel(i.label, runs, { ...base, a: i.url }); break;
    }
  }
  return runs;
}

const para = (runs: Run[]): Block[] => { const done = settled(runs); return done ? [{ k: 'p', runs: done }] : []; };
const bold = (s: string): Block[] => para(inlineModel(parseInline(s), [], { ...PLAIN, b: true }));

function answerModel(blocks: readonly AnswerBlock[]): Block[] {
  return blocks.flatMap((b): Block[] => {
    switch (b.k) {
      case 'verdict': {
        const runs: Run[] = [];
        pushRun(runs, `${t.companion.verdict[b.state]}:`, { ...PLAIN, b: true });
        pushText(runs, ' ', PLAIN);
        return para(inlineModel(parseInline(b.label), runs));
      }
      case 'para': return para(inlineModel(b.inline, []));
      case 'list': {
        const items = b.items.map((it) => settled(inlineModel(it, []))).filter((r): r is Run[] => r !== null).map((runs) => ({ value: null, runs }));
        return items.length ? [{ k: 'list', ordered: b.ordered, start: null, items }] : [];
      }
      case 'detail': return [...bold(b.title), ...answerModel(b.body)];
    }
  });
}

/** Copy under an answer: its Markdown as the text, its blocks as HTML (a folded Detail box included). */
export function answerCopy(markdown: string): Copied {
  return written(answerModel(parseAnswer(markdown)), markdown);
}

function itemModel(i: ThreadItem): Block[] {
  const head = bold(itemHeading(i));
  switch (i.kind) {
    case 'question': { const runs: Run[] = []; pushText(runs, i.text, PLAIN, true); return [...head, ...para(runs)]; }
    case 'answer': return [...head, ...answerModel(parseAnswer(i.markdown))];
    case 'error': return [...head, ...para(inlineModel([{ t: 'text', s: i.message }], []))];
    case 'catchup': {
      const c = i.data;
      if (c.points.length === 0) return [...head, ...para(inlineModel(parseInline(c.where), []))];
      const times = pointTimes(c.points, i.final);
      const items = c.points.map((p, k): ListItem => {
        const runs: Run[] = [];
        pushText(runs, `${POINT_GLYPH[p.status]} `, PLAIN);
        inlineModel(parseInline(p.text), runs);
        const time = times[k];
        if (time) pushText(runs, ` · ${time.text}`, PLAIN);
        if (p.note) { pushText(runs, ' — ', PLAIN); inlineModel(parseInline(p.note), runs); }
        return { value: count(String(p.n)), runs: settled(runs) ?? [] };
      });
      const summary = i.final && c.leftOpen ? { label: t.companion.leftOpen, text: c.leftOpen } : c.where ? { label: t.companion.where, text: c.where } : null;
      const choices = c.choices.map((x) => ({ value: null, runs: settled(inlineModel(parseInline(x), [])) ?? [] }));
      return [
        ...head, ...bold(t.companion.requests), { k: 'list', ordered: true, start: null, items },
        ...(summary ? [...bold(summary.label), ...para(inlineModel(parseInline(summary.text), []))] : []),
        ...(choices.length ? [...bold(t.companion.choices), { k: 'list' as const, ordered: false, start: null, items: choices }] : [])
      ];
    }
  }
}

/** Copy Thread: the Markdown it always copied as the text; as HTML, the session's name, then each item under its header. */
export function threadCopy(thread: Thread, title: string): Copied {
  const blocks = [...para(inlineModel([{ t: 'bold', s: t.companion.askAboutTitle(title) }], [])), ...thread.items.flatMap(itemModel)];
  return written(blocks, threadMarkdown(thread, title));
}

// --- writing both flavours -------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TAGS = ['strong', 'em', 'code'] as const;
/** A run's opening tags, outermost first: its link, then the formatting inside it. */
const tagsOf = (f: Fmt): string[] => [
  ...(f.a !== null ? [`a href="${esc(f.a).replace(/"/g, '&quot;')}"`] : []),
  ...TAGS.filter((x) => (x === 'strong' ? f.b : x === 'em' ? f.i : f.code))
];
const isPlain = (f: Fmt) => !f.b && !f.i && !f.code && f.a === null;
/** The formatting two neighbours share (a blank between them takes only that). */
const meet = (a: Fmt, b: Run | undefined): Fmt => (b === undefined || b === 'br' ? PLAIN : { b: a.b && b.b, i: a.i && b.i, code: a.code && b.code, a: a.a === b.a ? a.a : null });

/**
 * Runs as HTML: a tag stays open across the runs that share it (`<strong>Why <code>x</code></strong>`), and the blanks
 * at a formatted run's edges take only what their neighbour shares (`<strong>Done:</strong> label`).
 */
function runsHtml(runs: readonly Run[]): string {
  const parts: Run[] = [];
  runs.forEach((r, k) => {
    if (r === 'br' || isPlain(r)) { parts.push(r); return; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.s)!;
    if (!m[2]) { parts.push({ ...meet(meet(r, runs[k - 1]), runs[k + 1]), s: r.s }); return; }
    if (m[1]) parts.push({ ...meet(r, runs[k - 1]), s: m[1] });
    parts.push({ ...r, s: m[2] });
    if (m[3]) parts.push({ ...meet(r, runs[k + 1]), s: m[3] });
  });
  let out = '';
  const open: string[] = [];
  const close = (to: number) => { while (open.length > to) out += `</${open.pop()!.split(' ')[0]}>`; };
  for (const r of parts) {
    if (r === 'br') { out += '<br>'; continue; }
    const want = tagsOf(r);
    let keep = 0;
    while (keep < open.length && open[keep] === want[keep]) keep++;
    close(keep);
    for (const x of want.slice(keep)) { out += `<${x}>`; open.push(x); }
    out += esc(r.s);
  }
  close(0);
  return out;
}

/** Whether a link's label is its URL as written (a bare URL): the text then names it once. */
function labelIsUrl(label: string, url: string): boolean {
  try { return new URL(label.trim()).href === url; } catch { return false; }
}

/** Runs as plain text: a link's URL follows its label in parentheses, unless the label is the URL. */
function runsText(runs: readonly Run[]): string {
  let out = '';
  let from = 0;
  const linkOf = (r: Run | undefined) => (r === undefined || r === 'br' ? null : r.a);
  runs.forEach((r, k) => {
    if (r === 'br') { out += '\n'; return; }
    if (r.a !== null && linkOf(runs[k - 1]) !== r.a) from = out.length;
    out += r.s;
    if (r.a === null || linkOf(runs[k + 1]) === r.a) return;
    const label = out.slice(from);
    const trimmed = label.trimEnd();
    if (!labelIsUrl(label, r.a)) out = `${out.slice(0, from)}${trimmed} (${r.a})${label.slice(trimmed.length)}`;
  });
  return out;
}

function written(blocks: readonly Block[], text: string): Copied {
  const html = blocks.map((b) => {
    if (b.k === 'p') return `<p>${runsHtml(b.runs)}</p>`;
    const tag = b.ordered ? 'ol' : 'ul';
    const start = b.ordered && b.start !== null && b.start !== 1 ? ` start="${b.start}"` : '';
    return `<${tag}${start}>${b.items.map((it) => `<li${b.ordered && it.value !== null ? ` value="${it.value}"` : ''}>${runsHtml(it.runs)}</li>`).join('')}</${tag}>`;
  }).join('');
  return { html, text };
}

function textOf(blocks: readonly Block[]): string {
  return blocks.map((b) => {
    if (b.k === 'p') return runsText(b.runs);
    let n = b.start ?? 1;
    return b.items.map((it) => {
      if (!b.ordered) return `- ${runsText(it.runs)}`;
      if (it.value !== null) n = it.value;
      return `${n++}. ${runsText(it.runs)}`;
    }).join('\n');
  }).join('\n\n');
}
