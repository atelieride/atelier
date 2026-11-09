const isSep = (c: string | undefined) => c === '/' || c === '.' || c === '_' || c === '-' || c === ' ';

function subsequenceFrom(q: string, t: string, from: number): boolean {
  let pos = from;
  for (let i = 0; i < q.length; i++) {
    pos = t.indexOf(q[i]!, pos);
    if (pos === -1) return false;
    pos++;
  }
  return true;
}

/**
 * Fuzzy score: the query characters must appear in order. Letters at the start of a word count more
 * (after / . _ - or an uppercase after a lowercase), as do consecutive ones and those in the file name rather than the path.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!subsequenceFrom(q, t, 0)) return null;
  const base = t.lastIndexOf('/') + 1;
  const inName = base > 0 && subsequenceFrom(q, t, base);
  let score = inName ? 10 : 0;
  let pos = inName ? base : 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    let i = t.indexOf(c, pos);
    // If a little further on the same letter is at the start of a word, prefer that one.
    for (let j = i; j !== -1 && j < i + 12; j = t.indexOf(c, j + 1)) {
      const boundary = j === 0 || isSep(t[j - 1]) || (text[j]! !== t[j] && text[j - 1] === t[j - 1]);
      if (boundary && j !== prev + 1) { if (subsequenceFrom(q.slice(qi + 1), t, j + 1)) i = j; break; }
      if (j === prev + 1) break;
    }
    score += 1;
    if (i === prev + 1) score += 5;
    if (i === 0 || isSep(t[i - 1]) || (text[i]! !== t[i] && text[i - 1] === t[i - 1])) score += 8;
    if (i >= base) score += 2;
    score -= Math.min(4, Math.max(0, i - prev - 1) * 0.05);
    prev = i;
    pos = i + 1;
  }
  return score - t.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 50): T[] {
  if (!query) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, key(item));
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.item);
}

// ── Free text ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Conversation titles and first prompts, task titles, scheduled prompts: hundreds of characters of prose, where
// fuzzyScore's "the letters in order, anywhere" finds almost any query (bug 2026-11-02: "mcpcccccccccccccc" matched
// conversations through the c's of a 300-character prompt). Here every word of the query must be found close-knit in
// one of the fields: as it is (best as a whole word), or with a few letters skipped inside a short stretch (typos like
// "wrkspace", short forms like "dply"), or as the initials of words in a row ("flb" for "Fix login bug"). One or two
// letters: only together (or two initials).

/** Lowercase, without accents ("Perché" → "perche"), so neither the query nor the text needs them. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** How far a word may spread with letters skipped: 3 → 5 characters, 4 → 7, 8 → 13. */
const maxSpan = (len: number) => len + Math.floor(len / 2) + 1;

/** The query word is the initials of words in a row of the text ("flb": "fix login bug"). */
function initials(w: string, t: string): boolean {
  const starts: number[] = [];
  for (let i = 0; i < t.length; i++) if (isWordChar(t[i]) && !isWordChar(t[i - 1])) starts.push(i);
  for (let k = 0; k + w.length <= starts.length; k++) {
    let j = 0;
    while (j < w.length && t[starts[k + j]!] === w[j]) j++;
    if (j === w.length) return true;
  }
  return false;
}

/**
 * One query word against one folded field: 3 a whole word, 2.5 a word's start, 2 inside a word, 1.5 the initials of
 * words in a row, ~1 close-knit.
 */
function wordScore(w: string, t: string): number | null {
  let best: number | null = null;
  for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + 1)) {
    const s = isWordChar(t[i - 1]) ? 2 : isWordChar(t[i + w.length]) ? 2.5 : 3;
    if (best === null || s > best) best = s;
    if (best === 3) return best;
  }
  if (best !== null) return best;
  if (w.length >= 2 && initials(w, t)) return 1.5;
  if (w.length < 3) return null;
  const span = maxSpan(w.length);
  for (let i = t.indexOf(w[0]!); i !== -1; i = t.indexOf(w[0]!, i + 1)) {
    let pos = i + 1;
    let k = 1;
    for (; k < w.length; k++) {
      const at = t.indexOf(w[k]!, pos);
      if (at === -1 || at - i >= span) break;
      pos = at + 1;
    }
    if (k === w.length) return isWordChar(t[i - 1]) ? 1 : 1.25;
  }
  return null;
}

/**
 * A free-text match over a row's fields (earlier fields count a little more): null unless every word of the query is
 * found in some field; higher is better; 0 for an empty query.
 */
export function textScore(query: string, fields: readonly (string | null | undefined)[]): number | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const texts = fields.map((f) => (f ? fold(f) : ''));
  let total = 0;
  for (const w of words) {
    let best: number | null = null;
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]) continue;
      const s = wordScore(w, texts[i]!);
      if (s !== null && (best === null || s - i * 0.1 > best)) best = s - i * 0.1;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** textScore over a list: the matches, best first, the given order kept among equals (recency, usually). */
export function textFilter<T>(items: readonly T[], query: string, fields: (t: T) => readonly (string | null | undefined)[], limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = textScore(query, fields(item));
    if (s !== null) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.item);
}
