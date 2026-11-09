// JSON navigation: a value's path in the three formats Copy Path offers, the file bar's
// segments and the type label beside them. Pure.
import type { Segment } from './scan';
import { stringOf, type JsonNode } from './parse';

export type PathFormat = 'jq' | 'js' | 'pointer';

const JQ_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JS_NAME = /^[A-Za-z_$][\w$]*$/;

export function formatPath(path: readonly Segment[], fmt: PathFormat): string {
  if (fmt === 'pointer') return path.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
  const parts = path.map((s) => (typeof s === 'number' ? `[${s}]` : (fmt === 'jq' ? JQ_NAME : JS_NAME).test(s) ? `.${s}` : `[${JSON.stringify(s)}]`));
  if (fmt === 'js') return `data${parts.join('')}`;
  // jq: a bracket right after the root dot (.["x"]), never two dots.
  return parts.length ? parts.map((p, i) => (i === 0 && p.startsWith('[') ? `.${p}` : p)).join('') : '.';
}

/** A segment as the file bar and the tree show it: indices in brackets, the empty name quoted. */
export const segLabel = (s: Segment): string => (typeof s === 'number' ? `[${s}]` : s === '' ? '""' : s);

/** The file bar's segments, each with the path up to it. Deep paths: the first, "…" (the hidden part) and the last four. */
export function crumbs(path: readonly Segment[]): { label: string; path: Segment[] }[] {
  const all = path.map((s, i) => ({ label: segLabel(s), path: path.slice(0, i + 1) }));
  if (all.length <= 6) return all;
  return [all[0]!, { label: '…', path: path.slice(0, all.length - 4) }, ...all.slice(-4)];
}

/** The size of a text in UTF-8, without encoding it (the footer's "1.1 KB" on every parse). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Numbers over 999 in thin-space groups (1 284). */
export const groupNumber = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const plural = (n: number, one: string, many: string) => `${groupNumber(n)} ${n === 1 ? one : many}`;

/** What a folded block hides: "3 keys", "4 items". */
export const entriesLabel = (n: number, kind: 'object' | 'array'): string => (kind === 'object' ? plural(n, 'key', 'keys') : plural(n, 'item', 'items'));

export interface TypeInfo { type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'; length?: number; count?: number; objects?: boolean }

/** A parsed value's type for the file bar (Tree view). */
export function nodeInfo(n: JsonNode | null): TypeInfo | null {
  if (!n) return null;
  if (n.children) {
    const objects = n.type === 'array' && n.children.length > 0 && n.children.every((c) => c.type === 'object');
    return { type: n.type, count: n.children.length, ...(objects ? { objects } : {}) };
  }
  if (n.type === 'string') return { type: 'string', length: stringOf(n).length };
  return { type: n.type };
}

/** "string · 21 chars", "object · 3 keys", "array · 10 objects", "number". */
export function typeLabel(info: TypeInfo): string {
  if (info.type === 'string' && info.length !== undefined) return `string · ${plural(info.length, 'char', 'chars')}`;
  if (info.type === 'object' && info.count !== undefined) return `object · ${plural(info.count, 'key', 'keys')}`;
  if (info.type === 'array' && info.count !== undefined) return `array · ${info.objects ? plural(info.count, 'object', 'objects') : plural(info.count, 'item', 'items')}`;
  return info.type;
}
