// Source Control: the formats main asks git for and their parsers, plus the History filter
// grammar. Pure: main runs git, these read what came back.
import { FILTER_MAX, OID_RE, type ScmChangeKind, type ScmCommit, type ScmFileChange, type ScmPerson, type ScmRef, type ScmStash, type ScmWorktree } from './scm';

export const REF_FORMAT = '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:unix)%00%(creatordate:unix)';
/** Records start with RS: the newline git adds after each one never joins two records. */
export const LOG_FORMAT = '--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%(trailers:key=Co-authored-by,valueonly,separator=%x01)';
export const STASH_FORMAT = '--format=%x1e%gd%x00%H%x00%gs%x00%ct';

const num = (s: string | undefined) => Number(s) || 0;

/** `%(upstream:track,nobracket)`: "ahead 2, behind 1", "behind 3", "gone" or nothing. */
export function parseTrack(s: string): { ahead: number; behind: number; gone: boolean } {
  if (s.trim() === 'gone') return { ahead: 0, behind: 0, gone: true };
  return { ahead: num(/ahead (\d+)/.exec(s)?.[1]), behind: num(/behind (\d+)/.exec(s)?.[1]), gone: false };
}

/**
 * for-each-ref with REF_FORMAT, one ref per line. A remote's HEAD (origin/HEAD) is only a pointer: left out. `remotes`:
 * the configured remotes' names, so a remote named with a slash (team/fork) owns its branches; without them, the
 * first segment.
 */
export function parseRefs(out: string, remotes: readonly string[] = []): ScmRef[] {
  // Longest first: team/fork before team.
  const known = [...remotes].sort((a, b) => b.length - a.length);
  const refs: ScmRef[] = [];
  for (const line of out.split('\n')) {
    const f = line.split('\0');
    if (f.length < 8) continue;
    const [name, oid, peeled, upstream, track, head, cdate, crdate] = f as [string, string, string, string, string, string, string, string];
    if (!OID_RE.test(oid)) continue;
    let ref: ScmRef | null = null;
    const base = { name, oid, upstream: null, ahead: 0, behind: 0, gone: false, current: false };
    if (name.startsWith('refs/heads/')) {
      ref = { ...base, short: name.slice(11), kind: 'head', upstream: upstream || null, ...parseTrack(track), current: head === '*', date: num(cdate) };
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice(13);
      const remote = known.find((r) => short.startsWith(`${r}/`)) ?? (short.includes('/') ? short.slice(0, short.indexOf('/')) : null);
      if (!remote || short.slice(remote.length + 1) === 'HEAD') continue;
      ref = { ...base, short, kind: 'remote', remote, date: num(cdate) };
    } else if (name.startsWith('refs/tags/')) {
      ref = { ...base, short: name.slice(10), kind: 'tag', oid: OID_RE.test(peeled) ? peeled : oid, date: num(crdate) || num(cdate) };
    }
    if (ref) refs.push(ref);
  }
  return refs;
}

/** "Name <email>" (a trailer value), or just a name. */
function person(s: string): ScmPerson {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(s.trim());
  return m ? { name: m[1]!.trim(), email: m[2]!.trim() } : { name: s.trim(), email: '' };
}

// A record starts at RS followed by a full commit id and NUL: a subject or a name may hold an RS, never a NUL.
const LOG_RECORD = /\x1e(?=(?:[0-9a-f]{40}|[0-9a-f]{64})\0)/;

/**
 * log with LOG_FORMAT: RS-led records of 10 NUL-separated fields; anything malformed is skipped. A record is never
 * lost to an RS in its subject: a page that came back short would end the list and shift the next page's --skip.
 */
export function parseLog(out: string): ScmCommit[] {
  const commits: ScmCommit[] = [];
  for (const chunk of out.split(LOG_RECORD)) {
    if (!chunk) continue;
    const f = chunk.replace(/\n$/, '').split('\0');
    if (f.length !== 10 || !OID_RE.test(f[0]!)) continue;
    const [oid, parents, an, ae, at, cn, ce, ct, subject, co] = f as [string, string, string, string, string, string, string, string, string, string];
    commits.push({
      oid,
      parents: parents.split(' ').filter((p) => OID_RE.test(p)),
      author: { name: an, email: ae }, authorAt: num(at),
      committer: { name: cn, email: ce }, committerAt: num(ct),
      subject,
      coAuthors: co.split('\x01').map((s) => s.trim()).filter(Boolean).map(person)
    });
  }
  return commits;
}

/** `diff --numstat -z`: "a\tr\tpath\0", renames "a\tr\t\0old\0new\0", binary "-\t-". Keyed by the new path. */
function numstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const m = new Map<string, { added: number | null; removed: number | null }>();
  const rec = out.split('\0');
  for (let i = 0; i < rec.length; i++) {
    const parts = rec[i]!.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? null : Number(parts[0]);
    const removed = parts[1] === '-' ? null : Number(parts[1]);
    let path = parts.slice(2).join('\t');
    if (path === '') { path = rec[i + 2] ?? ''; i += 2; }
    if (path) m.set(path, { added, removed });
  }
  return m;
}

/**
 * `diff --raw -z -M a b` (":oldMode newMode oldOid newOid STATUS\0path\0[newPath\0]") with its `--numstat -z` counts.
 * A copy is a new file; a type change (file ↔ symlink) is T.
 */
export function parseRawDiff(raw: string, counts: string): ScmFileChange[] {
  const n = numstat(counts);
  const rec = raw.split('\0');
  const files: ScmFileChange[] = [];
  for (let i = 0; i < rec.length; i++) {
    const head = rec[i]!;
    if (!head.startsWith(':')) continue;
    const [oldMode, newMode, oldOid, newOid, status] = head.slice(1).split(' ') as [string, string, string, string, string];
    const letter = (status ?? '')[0];
    let rel: string; let origRel: string | undefined;
    if (letter === 'R' || letter === 'C') {
      const from = rec[i + 1]; const to = rec[i + 2];
      i += 2;
      if (!from || !to) continue;
      rel = to;
      if (letter === 'R') origRel = from;
    } else {
      const p = rec[i + 1];
      i += 1;
      if (!p) continue;
      rel = p;
    }
    const kind: ScmChangeKind = letter === 'C' || letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'R' ? 'R' : letter === 'T' ? 'T' : 'M';
    const c = n.get(rel) ?? { added: null, removed: null };
    files.push({ rel, ...(origRel ? { origRel } : {}), kind, added: c.added, removed: c.removed, oldMode, newMode, oldOid, newOid });
  }
  return files;
}

/** `worktree list --porcelain -z`: attribute fields, a worktree ending at an empty field. */
export function parseWorktrees(out: string): ScmWorktree[] {
  const list: ScmWorktree[] = [];
  let cur: ScmWorktree | null = null;
  for (const field of out.split('\0')) {
    if (field === '') { if (cur) list.push(cur); cur = null; continue; }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const val = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') { if (cur) list.push(cur); cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = OID_RE.test(val) ? val : null;
    else if (key === 'branch') cur.branch = val.startsWith('refs/heads/') ? val.slice(11) : val;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) list.push(cur);
  return list;
}

/** `log -g STASH_FORMAT refs/stash`: newest first. */
export function parseStashes(out: string): ScmStash[] {
  const list: ScmStash[] = [];
  for (const chunk of out.split('\x1e')) {
    const f = chunk.replace(/\n$/, '').split('\0');
    if (f.length !== 4 || !OID_RE.test(f[1]!)) continue;
    const index = Number(/\{(\d+)\}/.exec(f[0]!)?.[1]);
    if (!Number.isInteger(index)) continue;
    list.push({ index, oid: f[1]!, message: f[2]!, at: num(f[3]) });
  }
  return list;
}

export interface HistoryFilter { words: string[]; authors: string[]; paths: string[]; sha: string | null }

/**
 * The History filter: words match subject and body (all of them), `@name` the author, `path:dir` limits
 * to a path, one 4–40 hex word may be a commit id (jumped to when it resolves).
 */
export function parseHistoryFilter(text: string): HistoryFilter {
  const f: HistoryFilter = { words: [], authors: [], paths: [], sha: null };
  for (const tok of text.replace(/\0/g, '').slice(0, FILTER_MAX).split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('@') && tok.length > 1) f.authors.push(tok.slice(1));
    else if (tok.startsWith('path:') && tok.length > 5) {
      const p = tok.slice(5).replace(/^(?:\.?\/)+/, '');
      if (p && !p.split('/').includes('..')) f.paths.push(p);
    } else if (!f.sha && /^[0-9a-f]{4,40}$/i.test(tok)) f.sha = tok.toLowerCase();
    else f.words.push(tok);
  }
  return f;
}

export const isFilterEmpty = (f: HistoryFilter): boolean => !f.words.length && !f.authors.length && !f.paths.length && !f.sha;

/** git log arguments for a filter; `includeSha`: the hex word didn't resolve to a commit, so it is searched as a word. */
export function filterArgs(f: HistoryFilter, includeSha: boolean): { args: string[]; paths: string[] } {
  const words = includeSha && f.sha ? [...f.words, f.sha] : f.words;
  // Words and names are literal and case-insensitive (-F -i apply to --author too).
  const args = [...words.map((w) => `--grep=${w}`), ...(words.length ? ['--all-match'] : []), ...(words.length || f.authors.length ? ['-F', '-i'] : []), ...f.authors.map((a) => `--author=${a}`)];
  return { args, paths: f.paths.map((p) => `:(literal)${p}`) };
}
