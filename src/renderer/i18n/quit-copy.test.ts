import { expect, test } from 'vitest';
import { t } from './en';

// Quitting stops idle sessions (they wait under Resume) and shells at their prompt, so no
// string may still promise that everything stays alive when you quit.

function leaves(v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === 'string') out.push([path, v]);
  else if (typeof v === 'function') {
    try { leaves((v as (...a: unknown[]) => unknown)('X', 'Y', 'Z', 2), path, out); } catch { /* needs real arguments */ }
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
}

test('no string promises that every session and terminal survives a quit', () => {
  const all: [string, string][] = [];
  leaves(t, 't', all);
  expect(all.length).toBeGreaterThan(500);
  const promise = /\b(both|all|everything|your sessions)\b[^.]*\b(stays? alive|keeps? running)\b[^.]*\bquit/i;
  expect(all.filter(([, s]) => promise.test(s)).map(([p, s]) => `${p}: ${s}`)).toEqual([]);
});
