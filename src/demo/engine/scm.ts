// Source Control's history in the demo: what main's git reader answers (log with its
// scopes, filter and paging, locate, resolve, a commit's files against a base, a file at a commit), played over the
// commits, trees and blobs compiled at build time. Pure and Node-free: lookups and a line diff, no hashing.
import { parseHistoryFilter } from '@shared/git-history';
import { EMPTY_TREE, HISTORY_CAP, HISTORY_PAGE, type ScmBlob, type ScmCommit, type ScmCommitDetail, type ScmFileChange, type ScmLogPage, type ScmScope } from '@shared/scm';
import type { CompiledScm } from '../types';
import { numstat } from './repo';

const ZERO = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;

export interface History {
  log(scope: ScmScope, skip: number, count: number, filter?: string): ScmLogPage;
  locate(scope: ScmScope, oid: string): number | null;
  resolve(prefix: string): string | null;
  commit(oid: string, against: string | null): ScmCommitDetail;
  file(oid: string, rel: string): ScmBlob;
}

/** `refs`: full refname → commit id (what refs() lists); `head`: HEAD's commit. */
export function createHistory(scm: CompiledScm, at: { head: string; refs: Record<string, string> }): History {
  const byOid = new Map(scm.commits.map((c) => [c.oid, c]));
  /** A side of a range as main accepts it: a listed refname, HEAD, or a full commit id. */
  const rev = (r: string): string | null => (r === 'HEAD' ? at.head : at.refs[r] ?? (OID.test(r) && byOid.has(r) ? r : null));
  /** The commit and its ancestors, newest first (the history is linear: first parents are all there is). */
  const ancestry = (oid: string): ScmCommit[] => {
    const out: ScmCommit[] = [];
    for (let c = byOid.get(oid); c; c = c.parents[0] ? byOid.get(c.parents[0]) : undefined) out.push(c);
    return out;
  };
  const scoped = (scope: ScmScope): { list: ScmCommit[]; mergeBase?: string | null } | null => {
    if (scope.kind === 'compare') {
      const base = rev(scope.base), head = rev(scope.head);
      if (!base || !head) return null;
      const behind = new Set(ancestry(base).map((c) => c.oid));
      const list = ancestry(head);
      return { list: list.filter((c) => !behind.has(c.oid)), mergeBase: list.find((c) => behind.has(c.oid))?.oid ?? null };
    }
    if (scope.refs === 'all') return { list: scm.commits.filter((c) => ancestry(at.head).includes(c) || Object.values(at.refs).some((o) => ancestry(o).includes(c))) };
    const oid = rev(scope.refs);
    return oid ? { list: ancestry(oid) } : null;
  };
  const treeOf = (oid: string): Record<string, string> => scm.trees[oid] ?? {};
  const changed = (base: Record<string, string>, head: Record<string, string>): ScmFileChange[] =>
    [...new Set([...Object.keys(base), ...Object.keys(head)])].sort().flatMap((rel): ScmFileChange[] => {
      const a = base[rel], b = head[rel];
      if (a === b) return [];
      const n = numstat(a ? scm.blobs[a]! : '', b ? scm.blobs[b]! : '');
      return [{ rel, kind: !a ? 'A' : !b ? 'D' : 'M', ...n, oldMode: a ? '100644' : '000000', newMode: b ? '100644' : '000000', oldOid: a ?? ZERO, newOid: b ?? ZERO }];
    });
  const touches = (c: ScmCommit, paths: string[]) => {
    const files = changed(treeOf(c.parents[0] ?? ''), treeOf(c.oid)).map((f) => f.rel);
    return paths.some((p) => files.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, '')}/`)));
  };
  const resolve = (prefix: string): string | null => {
    if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
    const hits = scm.commits.filter((c) => c.oid.startsWith(prefix));
    return hits.length === 1 ? hits[0]!.oid : null;
  };

  return {
    log(scope, skip, count, filter) {
      const s = scoped(scope);
      if (!s) return { commits: [], done: true, capped: false, error: 'unknown ref' };
      const from = Math.max(0, Math.min(skip, HISTORY_CAP));
      const n = Math.max(0, Math.min(count, HISTORY_PAGE * 10, HISTORY_CAP - from));
      let list = s.list;
      if (filter) {
        // As main's filterArgs: words (all, literal, any case) in the message, @ in author name or email, path: limits.
        const f = parseHistoryFilter(filter);
        const words = (f.sha && !resolve(f.sha) ? [...f.words, f.sha] : f.words).map((w) => w.toLowerCase());
        list = list.filter((c) => {
          const msg = (scm.messages[c.oid] ?? c.subject).toLowerCase();
          const who = `${c.author.name} <${c.author.email}>`.toLowerCase();
          return words.every((w) => msg.includes(w)) && f.authors.every((a) => who.includes(a.toLowerCase())) && (!f.paths.length || touches(c, f.paths));
        });
      }
      const commits = list.slice(from, from + n);
      return { commits, done: commits.length < n, capped: from + commits.length >= HISTORY_CAP, ...(scope.kind === 'compare' && from === 0 ? { mergeBase: s.mergeBase ?? null } : {}) };
    },
    locate(scope, oid) {
      const i = scoped(scope)?.list.findIndex((c) => c.oid === oid) ?? -1;
      return i < 0 ? null : i;
    },
    resolve,
    commit(oid, against) {
      const c = byOid.get(oid);
      if (!c || (against !== null && !byOid.has(against))) return { oid, message: '', base: '', files: [], more: 0, error: 'bad commit' };
      const base = against ?? c.parents[0] ?? EMPTY_TREE.sha1;
      return { oid, message: scm.messages[oid] ?? c.subject, base, files: changed(treeOf(base), treeOf(oid)), more: 0 };
    },
    file(oid, rel) {
      const blob = scm.trees[oid]?.[rel];
      return blob === undefined ? { kind: 'missing' } : { kind: 'text', text: scm.blobs[blob]!, notUtf8: false };
    }
  };
}
