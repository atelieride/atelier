// Cuts the conversation's entries into the pieces a `chat` message carries: pages (the newest entries first, older
// ones on request) and chunks of live changes. Each piece stays within the entry count and the byte size of one message.
import type { Entry } from './types';

/** At most this many entries in a page. */
export const PAGE_ENTRIES = 200;
/** The most bytes of JSON one `chat` message may have, wrapper included. */
export const PAGE_BYTES = 512 * 1024;
/** Bytes kept free in each message for what wraps the entries: type, id, request id, conversation key, flags. */
export const WRAPPER_BYTES = 2048;

const utf8 = new TextEncoder();
const BUDGET = PAGE_BYTES - WRAPPER_BYTES;

// An entry too big for a page by itself goes alone, on a page of its own: a reader always makes progress.
/** Bytes an entry takes inside the JSON array: its UTF-8 JSON plus the comma that separates it. */
function weigh(e: Entry): number {
  return utf8.encode(JSON.stringify(e)).length + 1;
}

/**
 * The newest entries with `n < before` (all when absent): at most PAGE_ENTRIES and BUDGET bytes, and at least one
 * (an entry over the budget goes alone). `start` when the page holds entry 1, or there is nothing.
 */
export function pageOf(entries: readonly Entry[], before?: number): { entries: Entry[]; start: boolean } {
  let end = entries.length;
  if (before !== undefined) while (end > 0 && (entries[end - 1]?.n ?? 0) >= before) end--;
  let from = end;
  let bytes = 0;
  while (from > 0 && end - from < PAGE_ENTRIES) {
    const w = weigh(entries[from - 1] as Entry);
    if (from < end && bytes + w > BUDGET) break;
    bytes += w;
    from--;
  }
  const page = entries.slice(from, end);
  return { entries: page, start: page.length === 0 || page[0]?.n === 1 };
}

/** The entries in order, in groups that each fit one message (an entry over the budget is a group of its own). */
export function chunks(entries: readonly Entry[]): Entry[][] {
  const out: Entry[][] = [];
  let cur: Entry[] = [];
  let bytes = 0;
  for (const e of entries) {
    const w = weigh(e);
    if (cur.length > 0 && bytes + w > BUDGET) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += w;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
