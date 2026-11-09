// Ask companion: the answer Markdown the model writes (see rules.ts) as blocks the renderer draws.
// Deliberately tiny: verdict line, `:::detail` folds, paragraphs, lists, bold/italic/code and file references.
// HTML and links stay literal text. Never throws; input is capped so a runaway answer can't hang the renderer.

export type Inline =
  | { t: 'text' | 'bold' | 'italic' | 'code'; s: string }
  | { t: 'file'; path: string; from: number | null; to: number | null; raw: string };

export type AnswerBlock =
  | { k: 'verdict'; state: 'done' | 'in-progress' | 'not-started' | 'unclear'; label: string; progress: { n: number; m: number } | null }
  | { k: 'para'; inline: Inline[] }
  | { k: 'list'; ordered: boolean; items: Inline[][] }
  | { k: 'detail'; title: string; body: AnswerBlock[] };

const MAX_INPUT = 64 * 1024;
const STATES = new Set(['done', 'in-progress', 'not-started', 'unclear']);

/**
 * A candidate project-relative reference from `path`, `path:58` or `path:41–77`; null when it is plain code. One written
 * with backslashes (the model does on Windows) is the same path with forward slashes, so a UNC or rooted one (`\\…`,
 * `\…`) is absolute and stays code; a drive (`C:\…`) never matches.
 */
function fileRef(code: string): Inline | null {
  const m = /^([^:\s]+)(?::(\d+)(?:[–-](\d+))?)?$/.exec(code);
  if (!m) return null;
  const path = m[1]!.replace(/\\/g, '/');
  if (path.length > 300 || path.startsWith('/') || path.startsWith('~') || path.endsWith('/')) return null;
  const segs = path.split('/');
  if (segs.includes('..') || segs.includes('')) return null;
  if (!path.includes('/') && !/\.[A-Za-z0-9]+$/.test(path)) return null;
  const from = m[2] !== undefined ? Number(m[2]) : null;
  const to = m[3] !== undefined ? Number(m[3]) : null;
  if (from !== null && (!Number.isSafeInteger(from) || from < 1)) return null;
  if (to !== null && (!Number.isSafeInteger(to) || to < from!)) return null;
  return { t: 'file', path, from, to, raw: code };
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

/** One paragraph's spans (bold, italic, code, file references): also the Catch me up card's texts. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  // A failed closer search from `s` to the end of the line means no later opener on that line finds one either.
  const failed: Record<string, { from: number; to: number }> = {};
  const flush = (): void => { if (text) { out.push({ t: 'text', s: text }); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        const code = src.slice(i + 1, end);
        out.push(fileRef(code) ?? { t: 'code', s: code });
        i = end + 1;
        continue;
      }
    } else if (c === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'bold', s: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    } else if ((c === '*' || c === '_') && src[i + 1] !== undefined && !/\s/.test(src[i + 1]!) && src[i + 1] !== c && !(c === '_' && isWord(src[i - 1]))) {
      const f = failed[c];
      if (!f || i + 2 < f.from || i + 2 > f.to) {
        const nl = src.indexOf('\n', i + 2);
        const lineEnd = nl === -1 ? src.length : nl;
        let end = src.indexOf(c, i + 2);
        while (end !== -1 && end < lineEnd && (/\s/.test(src[end - 1]!) || (c === '_' && isWord(src[end + 1])))) end = src.indexOf(c, end + 1);
        if (end !== -1 && end < lineEnd && end > i + 1) {
          flush();
          out.push({ t: 'italic', s: src.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
        failed[c] = { from: i + 2, to: lineEnd };
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const BULLET = /^\s{0,3}[-*] +(.*)$/;
const ORDERED = /^\s{0,3}\d+\. +(.*)$/;
const DETAIL = /^:::detail(?:\s+(.*))?$/;

function parseBlocks(lines: string[], allowDetail: boolean): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ k: 'para', inline: parseInline(para.join('\n')) });
    para = [];
  };
  let noClose = false; // a search for `:::` that found none holds for every later opener too
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '') { flush(); i++; continue; }
    const d = allowDetail ? DETAIL.exec(trimmed) : null;
    if (d && !noClose) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trim() === ':::') { close = j; break; }
      if (close === -1) noClose = true;
      if (close !== -1) {
        flush();
        blocks.push({ k: 'detail', title: (d[1] ?? '').trim(), body: parseBlocks(lines.slice(i + 1, close), false) });
        i = close + 1;
        continue;
      }
    }
    const kind = BULLET.test(line) ? 'bullet' : ORDERED.test(line) ? 'ordered' : null;
    if (kind) {
      flush();
      const re = kind === 'bullet' ? BULLET : ORDERED;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ k: 'list', ordered: kind === 'ordered', items });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

export function parseAnswer(md: string): AnswerBlock[] {
  try {
    const lines = md.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
    const blocks: AnswerBlock[] = [];
    const first = lines.length > 0 ? lines[0]!.slice(0, 500).trimEnd() : '';
    const m = /^Verdict:\s*(\S+)\s+[—–-]\s+(.+)$/.exec(first);
    if (m && STATES.has(m[1]!)) {
      const label = m[2]!;
      const p = /(\d{1,9})\s{0,3}\/\s{0,3}(\d{1,9})/.exec(label.slice(0, 200));
      const n = p ? Number(p[1]) : 0, mm = p ? Number(p[2]) : 0;
      blocks.push({ k: 'verdict', state: m[1] as 'done', label, progress: p && mm >= 1 && n <= mm ? { n, m: mm } : null });
      lines.shift();
    }
    return [...blocks, ...parseBlocks(lines, true)];
  } catch {
    return [];
  }
}
