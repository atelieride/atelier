// Discard: what the sheet lists and asks, who wrote the lines (the sessions that surely did), the
// session editing them now, and the one toast after it. Pure: main does the Trash and the restore.
import { isUnsure, type Attribution } from '@shared/attribution';
import type { FileChange, RepoStatus } from '@shared/git';
import type { GitOpResult, StageTarget } from '@shared/git-write';
import { fileList } from '../changes';
import { t } from '../i18n/en';
import type { LiveBy } from './live';

export interface DiscardTarget { root: string; rels: StageTarget }
export interface DiscardBy { terminalId: string; title: string; color: string }
/** A listed file: a rename by its new path (`origRel` its old one), `live` the session editing it now. */
export interface DiscardFile { root: string; rel: string; origRel?: string; path: string; kind: FileChange['kind'] | null; by: DiscardBy[]; live: LiveBy | null }
/** `notListed`: past the status cap (a repository's Discard All covers them too); `count`: every file the discard covers. */
export interface DiscardPlan { files: DiscardFile[]; notListed: number; count: number }

const base = (rel: string) => rel.split('/').pop() ?? rel;

/**
 * The files the sheet lists, in Changes' order: a repository's every listed change ('all'), or the rows' paths (a
 * rename's both are one file). A path Changes no longer lists still counts, by its path: main decides what it does.
 */
export function discardPlan(targets: readonly DiscardTarget[], repos: readonly Pick<RepoStatus, 'root' | 'changes' | 'truncated'>[], attributions: readonly Attribution[], live: ReadonlyMap<string, LiveBy>): DiscardPlan {
  const files: DiscardFile[] = [];
  let notListed = 0;
  const byOf = (path: string): DiscardBy[] => {
    const out = new Map<string, DiscardBy>();
    for (const a of attributions) if (a.path === path && !isUnsure(a) && !out.has(a.terminalId)) out.set(a.terminalId, { terminalId: a.terminalId, title: a.title, color: a.color });
    return [...out.values()];
  };
  const add = (root: string, c: Pick<FileChange, 'rel' | 'origRel' | 'path'> & { kind: FileChange['kind'] | null }) =>
    files.push({ root, rel: c.rel, ...(c.origRel ? { origRel: c.origRel } : {}), path: c.path, kind: c.kind, by: byOf(c.path), live: live.get(c.path) ?? null });
  for (const x of targets) {
    const repo = repos.find((r) => r.root === x.root);
    const changes = repo?.changes ?? [];
    if (x.rels === 'all') {
      for (const c of changes) add(x.root, c);
      notListed += repo?.truncated ?? 0;
      continue;
    }
    const want = new Set(x.rels);
    const covered = new Set<string>();
    for (const c of changes) {
      if (!want.has(c.rel) && !(c.origRel && want.has(c.origRel))) continue;
      add(x.root, c);
      covered.add(c.rel);
      if (c.origRel) covered.add(c.origRel);
    }
    for (const rel of x.rels) if (!covered.has(rel)) add(x.root, { rel, path: `${x.root}/${rel}`, kind: null });
  }
  return { files, notListed, count: files.length + notListed };
}

/** "Discard changes to welcome.tsx?" / "Discard changes to 4 files?" */
export function discardTitle(plan: DiscardPlan): string {
  const d = t.git.discard;
  if (plan.count === 0) return d.titleNone;
  return d.title(plan.count === 1 && plan.files.length === 1 ? base(plan.files[0]!.rel) : d.files(plan.count));
}

/** The sky notice: the sessions editing these files now, the first one's color on its dot. */
export function liveNotice(plan: DiscardPlan): { text: string; color: string } | null {
  const live = plan.files.filter((f) => f.live);
  if (!live.length) return null;
  const who = new Map(live.map((f) => [f.live!.terminalId, f.live!]));
  return { text: t.git.discard.live([...who.values()].map((w) => w.title), live.length, plan.count), color: live[0]!.live!.color };
}

/** A toast that names files lasts longer than the 5 s of a plain one. */
const LONG_MS = 10_000;
const KEPT = /\b(\d+ files? kept)\b/;

/**
 * Main's answer with the files it didn't discard named: after "N files kept" when they are only kept ones, else at the
 * end (main's `files` mixes kept and left-alone ones).
 */
function withNames(text: string, files: readonly string[]): string {
  const names = fileList(files.map(base));
  return KEPT.test(text) && !/left alone/.test(text) ? text.replace(KEPT, `$1 (${names})`) : `${text} (${names})`;
}

/**
 * The one toast after the sheet: per working tree, how many files went to the Trash and the ones main kept, with
 * its reason; a failure says the failure (`fail`, from failText). Several working trees: each by name. No Undo: the
 * Trash is the undo. Info when every one went through; longer when it names files or something failed.
 */
export function discardToast(done: readonly { name: string; r: GitOpResult; fail: string }[]): { text: string; tone?: 'info'; ms?: number } {
  const said = done.map(({ name, r, fail }) => {
    const kept = (r.outcome === 'ok' || r.outcome === 'state') && !!r.files?.length;
    const text = r.outcome === 'ok' ? r.message ?? t.git.discard.done : r.outcome === 'state' && r.message ? r.message : fail;
    const full = kept ? withNames(text, r.files!) : text;
    return done.length > 1 ? t.git.discard.inRepo(name, full) : full;
  });
  const ok = done.every((d) => d.r.outcome === 'ok');
  const long = !ok || done.some((d) => !!d.r.files?.length);
  return { text: said.join('; '), ...(ok ? { tone: 'info' as const } : {}), ...(long ? { ms: LONG_MS } : {}) };
}
