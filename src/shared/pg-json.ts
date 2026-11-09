// Databases view: JSON helpers and the identifier quoting every SQL
// builder relies on. Pure and free of Node APIs: it runs in main (builders) and in the renderer (profile, paths).

import type { DbPath } from './databases-filters';

/** 'masked': a secret key's value with Mask values on, its kind not said. */
export type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'mixed' | 'unix' | 'masked';
export interface KeyStat { path: DbPath; kind: JsonKind; present: number }

/** A Postgres identifier: double quotes around, inner quotes doubled. Never empty, never NUL. */
export function quoteIdent(s: string): string {
  if (s === '') throw new TypeError('An identifier cannot be empty');
  if (s.includes('\0')) throw new TypeError('An identifier cannot contain NUL');
  return `"${s.replace(/"/g, '""')}"`;
}

const TIME_KEY = /(^|_)(at|time|ts|timestamp|created|updated|date|expires?)($|_)/i;

export function looksUnixTime(key: string | number, v: unknown): boolean {
  return typeof key === 'string' && typeof v === 'number' && v >= 1e9 && v <= 2e10 && TIME_KEY.test(key);
}

export function jsonInString(v: unknown): unknown | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const SIMPLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function pathText(path: DbPath): string {
  let out = '';
  for (const p of path) {
    if (typeof p === 'number') out += `[${Math.trunc(p)}]`;
    else if (SIMPLE_KEY.test(p)) out += out === '' ? p : `.${p}`;
    else out += `[${JSON.stringify(p)}]`;
  }
  return out;
}

export function pathLabel(path: DbPath): string {
  const last = path[path.length - 1];
  if (last === undefined) return '';
  return typeof last === 'number' ? `[${Math.trunc(last)}]` : last;
}

function arrayElement(p: string | number): string {
  if (typeof p === 'number') {
    if (!Number.isFinite(p)) throw new TypeError('A path index must be a number');
    return String(Math.trunc(p));
  }
  if (p === '' || /[,{}"\\\s]/.test(p) || p.toUpperCase() === 'NULL') return `"${p.replace(/["\\]/g, '\\$&')}"`;
  return p;
}

/** `'{a,0,b}'`: a path as a quoted text-array literal, single quotes doubled. A NaN or infinite index throws. */
export function pathLiteral(path: DbPath): string {
  return `'${`{${path.map(arrayElement).join(',')}}`.replace(/'/g, "''")}'`;
}

/**
 * `"col" #>> '{a,0,b}'`: the path as a text-array literal, single quotes doubled. `#>` reads the JSON itself rather than
 * its text (at path exists: `#> … IS NOT NULL`).
 */
export function pathSql(column: string, path: DbPath, op: '#>>' | '#>' = '#>>'): string {
  return `${quoteIdent(column)} ${op} ${pathLiteral(path)}`;
}

/** A caller's own leaves: a lossless number, a masked value — their kind, or undefined for the usual. */
export type LeafKind = (key: string, v: unknown) => JsonKind | undefined;

function kindOf(key: string, v: unknown, leaf?: LeafKind): JsonKind {
  const own = leaf?.(key, v);
  if (own !== undefined) return own;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'number': return looksUnixTime(key, v) ? 'unix' : 'number';
    case 'boolean': return 'boolean';
    default: return 'object';
  }
}

/**
 * The key paths of some JSON values: objects walked to `depth`, arrays one path of kind array, each path's
 * kind (mixed when they differ) and how many values hold it; sorted by presence then path, `max` of them. `leaf`: the
 * caller's own leaves (the renderer's lossless numbers, a masked key's value), named first and never walked into. A
 * depth below 1 walks no level.
 */
export function keyProfile(values: readonly unknown[], o: { depth?: number; max?: number; leaf?: LeafKind } = {}): KeyStat[] {
  const depth = o.depth ?? 4;
  const max = o.max ?? 40;
  if (depth < 1) return [];
  const stats = new Map<string, KeyStat>();
  const walk = (obj: Record<string, unknown>, prefix: string[]): void => {
    for (const [key, v] of Object.entries(obj)) {
      const path = [...prefix, key];
      const kind = kindOf(key, v, o.leaf);
      const id = JSON.stringify(path);
      const s = stats.get(id);
      if (!s) stats.set(id, { path, kind, present: 1 });
      else {
        s.present++;
        if (s.kind !== kind) s.kind = 'mixed';
      }
      if (kind === 'object' && path.length < depth) walk(v as Record<string, unknown>, path);
    }
  };
  for (const v of values) {
    // A whole value the caller names (a lossless number is an object too) has no keys.
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && o.leaf?.('', v) === undefined) walk(v as Record<string, unknown>, []);
  }
  // Each path's text once, not twice a comparison.
  return [...stats.values()]
    .map((s) => ({ s, t: pathText(s.path) }))
    .sort((a, b) => b.s.present - a.s.present || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .slice(0, max)
    .map((x) => x.s);
}
