// Find in the Markdown preview: the same query as the editor's find card, run over the
// rendered text (not the markup). The DOM side maps these offsets back to text nodes.
import type { FindSpec } from '../editor/find/find-logic';

export interface TextMatches { ranges: { from: number; to: number }[]; capped: boolean; valid: boolean }

const WORD = /[\p{L}\p{N}_]/u;
const isWordAt = (text: string, i: number) => i >= 0 && i < text.length && WORD.test(text[i]!);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findInText(text: string, spec: FindSpec, cap = 9999): TextMatches {
  if (!spec.search) return { ranges: [], capped: false, valid: true };
  let re: RegExp;
  try { re = new RegExp(spec.regexp ? spec.search : escape(spec.search), spec.caseSensitive ? 'gu' : 'giu'); } catch { return { ranges: [], capped: false, valid: false }; }
  const ranges: { from: number; to: number }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    if (to === from) { re.lastIndex = from + 1; continue; }
    if (spec.wholeWord && (isWordAt(text, from - 1) || isWordAt(text, to))) continue;
    if (ranges.length >= cap) return { ranges, capped: true, valid: true };
    ranges.push({ from, to });
  }
  return { ranges, capped: false, valid: true };
}

/** The next (dir 1) or previous match index, wrapping; -1 when there are none. */
export function nextIndex(at: number, total: number, dir: 1 | -1): number {
  if (!total) return -1;
  if (at < 0) return dir === 1 ? 0 : total - 1;
  return (at + dir + total) % total;
}
