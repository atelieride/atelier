import type { ChangeKind, FileChange } from '@shared/git';
import { stageOf } from '@shared/git-write';

function kindOf(xy: string): ChangeKind {
  const x = xy[0] ?? '.'; const y = xy[1] ?? '.';
  // A file added to the index and then changed again (AM) is still new against HEAD: not in HEAD at all.
  const letter = x === 'A' && y === 'M' ? 'A' : y !== '.' ? y : x;
  return letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'R' || letter === 'C' ? 'R' : 'M';
}

/** A change as main's own git writes read it: a rename's object names in HEAD (its old path) and in the index. */
export interface StatusChange extends FileChange { headOid?: string; indexOid?: string }

/**
 * `git status --porcelain=v2 --branch -z`: NUL-separated records; renames have one extra record (the old name).
 * `oids`: a rename keeps its hH and hI (Discard, git-ops.ts); the statuses the windows get never carry them.
 */
export function parseStatusV2(out: string, repoRoot: string, o: { oids?: boolean } = {}) {
  const rec = out.split('\0');
  let branch: string | null = null; let detached = false; let ahead = 0; let behind = 0; let oid: string | null = null; let upstream: string | null = null;
  let counted = false;
  const changes: StatusChange[] = [];
  // sub: "N..." for a file, "S<c><m><u>" for a submodule.
  const mk = (rel: string, kind: ChangeKind, stage: FileChange['stage'], sub?: string, origRel?: string): FileChange =>
    ({ path: `${repoRoot}/${rel}`, rel, kind, stage, added: null, removed: null, ...(origRel ? { origRel } : {}), ...(sub?.startsWith('S') ? { submodule: true as const } : {}) });
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i]!;
    if (!r) continue;
    if (r.startsWith('# branch.oid ')) {
      const o = r.slice('# branch.oid '.length);
      oid = o === '(initial)' ? null : o;
    } else if (r.startsWith('# branch.head ')) {
      const h = r.slice('# branch.head '.length);
      if (h === '(detached)') detached = true; else branch = h;
    } else if (r.startsWith('# branch.upstream ')) {
      upstream = r.slice('# branch.upstream '.length) || null;
    } else if (r.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(r);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); counted = true; }
    } else if (r.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = r.split(' ');
      changes.push(mk(parts.slice(8).join(' '), kindOf(parts[1]!), stageOf(parts[1]!), parts[2]));
    } else if (r.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = r.split(' ');
      const orig = rec[i + 1] ?? '';
      i += 1;
      // A copy (status.renames=copies) is a new file: its source stays where it is, a change of its own or none.
      if (parts[8]?.startsWith('C')) { changes.push(mk(parts.slice(9).join(' '), 'A', stageOf(parts[1]!), parts[2])); continue; }
      const c: StatusChange = mk(parts.slice(9).join(' '), 'R', stageOf(parts[1]!), parts[2], orig);
      if (o.oids) { c.headOid = parts[6]; c.indexOid = parts[7]; }
      changes.push(c);
    } else if (r.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path: unmerged, not stageable.
      const parts = r.split(' ');
      changes.push(mk(parts.slice(10).join(' '), 'U', 'none', parts[2]));
    } else if (r.startsWith('? ')) {
      changes.push(mk(r.slice(2), '?', 'none'));
    }
  }
  // An upstream without `# branch.ab`: its remote branch is gone (git counts only against one that exists).
  const upstreamGone = !!upstream && !counted && oid !== null;
  return { branch, detached, ahead, behind, oid, upstream, upstreamGone, changes };
}

/**
 * `git diff --name-status -z <commit>`: "M\0path\0", "R087\0old\0new\0", "C075\0old\0new\0". A copy is a new file
 * (its base side doesn't exist at the commit); a type change (T) is shown as modified.
 */
export function parseNameStatus(out: string, repoRoot: string): FileChange[] {
  const rec = out.split('\0');
  const changes: FileChange[] = [];
  const mk = (rel: string, kind: ChangeKind, origRel?: string): FileChange =>
    ({ path: `${repoRoot}/${rel}`, rel, kind, stage: 'none', added: null, removed: null, ...(origRel ? { origRel } : {}) });
  for (let i = 0; i < rec.length; i++) {
    const code = rec[i]!;
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const from = rec[i + 1]; const to = rec[i + 2];
      i += 2;
      if (!from || !to) continue;
      changes.push(letter === 'R' ? mk(to, 'R', from) : mk(to, 'A'));
      continue;
    }
    const rel = rec[i + 1];
    i += 1;
    if (!rel) continue;
    changes.push(mk(rel, letter === 'A' ? 'A' : letter === 'D' ? 'D' : letter === 'U' ? 'U' : 'M'));
  }
  return changes;
}

/** `git diff --numstat -z`: "a\tr\tpath\0" or, for renames, "a\tr\t\0old\0new\0". Binary files: "-\t-". */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const m = new Map<string, { added: number | null; removed: number | null }>();
  const rec = out.split('\0');
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i]!;
    if (!r) continue;
    const parts = r.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? null : Number(parts[0]);
    const removed = parts[1] === '-' ? null : Number(parts[1]);
    let path = parts.slice(2).join('\t');
    if (path === '') { path = rec[i + 2] ?? ''; i += 2; }
    if (path) m.set(path, { added, removed });
  }
  return m;
}
