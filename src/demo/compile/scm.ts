// Source Control's history, compiled: the world's three commits on `main` as git would
// list them — ids, parents, Ada Lovelace as author, dates before t0 — and each commit's tree as blob ids over a blob
// store, so the runtime answers log, commit details and "file at a commit" by lookups and a line diff, never by
// hashing (the browser has no synchronous SHA-1). Node only.
import { createHash } from 'node:crypto';
import type { ScmCommit } from '../../shared/scm';
import type { CompiledScm } from '../types';
import { COMPOSE } from '../world/docker';
import { AUTHOR, FILES, type Commit } from '../world/project';

/**
 * Files of the demo's project that are not in the screenshots' FILES: the compose file the Docker view links to
 * (Inspect › compose.yml:17, "Ask Claude why it crashed" quotes its service). Committed with the first commit.
 */
export const EXTRA_FILES: Record<string, string> = { 'compose.yml': COMPOSE };

/** git's blob id: sha1 of `blob <bytes>\0<content>`. */
export const blobOid = (text: string): string => {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
};

/** Commit ids: a SHA-1 over the parent and the message, so each is stable and 40 hex long like the real ones. */
export function commitOids(commits: readonly Commit[]): (Commit & { oid: string })[] {
  let parent = '';
  return commits.map((c) => ({ ...c, oid: (parent = createHash('sha1').update(`${parent}\n${c.message}`).digest('hex')) }));
}

/** How long before t0 each commit was made, oldest first (a project started three days ago, tested this morning). */
const AGO_S = [3 * 86_400 + 4 * 3600, 26 * 3600 + 17 * 60, 3 * 3600 + 41 * 60];

export function compileScm(commits: readonly (Commit & { oid: string })[], t0: number): CompiledScm {
  const trees: CompiledScm['trees'] = {};
  const blobs: CompiledScm['blobs'] = {};
  const messages: CompiledScm['messages'] = {};
  const list: ScmCommit[] = [];
  let tree: Record<string, string> = {};
  commits.forEach((c, i) => {
    tree = { ...tree };
    const added = { ...(i === 0 ? EXTRA_FILES : {}), ...Object.fromEntries(c.files.map((rel) => [rel, FILES[rel]!])) };
    for (const [rel, text] of Object.entries(added)) {
      const oid = blobOid(text);
      blobs[oid] = text;
      tree[rel] = oid;
    }
    trees[c.oid] = tree;
    messages[c.oid] = c.message;
    const at = Math.floor(t0 / 1000) - (AGO_S[i] ?? 60 * (commits.length - i));
    list.unshift({ oid: c.oid, parents: i ? [commits[i - 1]!.oid] : [], author: AUTHOR, authorAt: at, committer: AUTHOR, committerAt: at, subject: c.message.split('\n')[0]!, coAuthors: [] });
  });
  return { commits: list, messages, trees, blobs };
}
