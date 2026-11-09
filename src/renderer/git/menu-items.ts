// The git items of Changes' context menus, first in each menu, before today's items. Staging
// from a menu never opens the drawer; Discard only opens its sheet. Read-only: no item at all.
import type { MenuItem } from '../menu-model';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { commitWork, stage, unstage } from './actions';
import { relsOf, stageable, type StageRow } from './staging';

const st = () => useApp.getState();
const m = t.git.menu;
const writes = () => st().settings.gitActions === 'on';
const canStage = (r: StageRow) => stageable(r).ok;

/** Each root's paths, in the rows' order (a rename's both). */
function byRoot(rows: readonly StageRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const rels = out.get(r.repo) ?? [];
    for (const rel of relsOf(r)) if (!rels.includes(rel)) rels.push(rel);
    out.set(r.repo, rels);
  }
  return out;
}

async function each(rows: readonly StageRow[], fn: (root: string, rels: string[]) => Promise<unknown>): Promise<void> {
  for (const [root, rels] of byRoot(rows)) await fn(root, rels);
}

const discardSheet = (rows: readonly StageRow[]) => st().setGitSheet({ kind: 'discard', targets: [...byRoot(rows)].map(([root, rels]) => ({ root, rels })) });

/**
 * A file row: Stage (nothing or part of it staged), Unstage (all or part of it), Discard Changes…. A file that can't
 * stage (unmerged, a submodule) can't be discarded either: restoring it would settle a conflict or trash a whole
 * submodule's checkout.
 */
export function fileGitItems(row: StageRow): MenuItem[] {
  if (!writes()) return [];
  const ok = stageable(row);
  const blocked = ok.ok ? {} : { disabled: true, tip: ok.reason };
  return [
    ...(row.stage !== 'all' || !ok.ok ? [{ id: 'git-stage', label: m.stage, icon: 'plus' as const, ...blocked, run: () => void stage(row.repo, relsOf(row)) }] : []),
    ...(row.stage !== 'none' && ok.ok ? [{ id: 'git-unstage', label: m.unstage, run: () => void unstage(row.repo, relsOf(row)) }] : []),
    { id: 'git-discard', label: m.discard, icon: 'trash', danger: true, ...blocked, run: () => discardSheet([row]) },
    'sep'
  ];
}

/**
 * A file tab: Discard Changes… when Changes lists the file (by its path, a rename by its new one), like its
 * row's; nothing for a clean file.
 */
export function tabGitItems(path: string): MenuItem[] {
  if (!writes()) return [];
  for (const r of st().repos) {
    const c = r.changes.find((x) => x.path === path);
    if (!c) continue;
    const row: StageRow = { ...c, repo: r.root };
    const ok = stageable(row);
    return [{ id: 'git-discard', label: m.discard, icon: 'trash', danger: true, ...(ok.ok ? {} : { disabled: true, tip: ok.reason }), run: () => discardSheet([row]) }];
  }
  return [];
}

/**
 * A repository (or worktree) header: Stage All, Unstage All and Discard All cover the whole repository, past the
 * status cap too ("+N files not listed"); Commit… opens the drawer on it.
 */
export function repoGitItems(root: string): MenuItem[] {
  if (!writes()) return [];
  const repo = st().repos.find((r) => r.root === root);
  const more = repo?.truncated ?? 0;
  const rows: StageRow[] = (repo?.changes ?? []).map((c) => ({ ...c, repo: root }));
  const tip = more > 0 ? { tip: t.git.notListed(more) } : {};
  return [
    { id: 'git-stage-all', label: m.stageAll, icon: 'plus', disabled: more === 0 && !rows.some((r) => canStage(r) && r.stage !== 'all'), ...tip, run: () => void stage(root, 'all') },
    { id: 'git-unstage-all', label: m.unstageAll, disabled: more === 0 && !rows.some((r) => r.stage !== 'none'), ...tip, run: () => void unstage(root, 'all') },
    { id: 'git-commit', label: m.commit, icon: 'commit', run: () => st().openGitDrawer({ root }) },
    { id: 'git-discard-all', label: m.discardAll, icon: 'trash', danger: true, disabled: more === 0 && rows.length === 0, ...tip, run: () => st().setGitSheet({ kind: 'discard', targets: [{ root, rels: 'all' }] }) },
    'sep'
  ];
}

/**
 * A session header (`key` 'unknown': the Unknown origin group, no work to commit): its listed files only, those it
 * surely changed.
 */
export function sessionGitItems(g: { key: string; title: string; rows: readonly StageRow[] }): MenuItem[] {
  if (!writes() || g.rows.length === 0) return [];
  const usable = g.rows.filter(canStage);
  const toStage = usable.filter((r) => r.stage !== 'all');
  const toUnstage = usable.filter((r) => r.stage !== 'none');
  return [
    ...(g.key === 'unknown' ? [] : [{ id: 'git-commit-work', label: m.commitWork(g.title), icon: 'commit' as const, disabled: usable.length === 0, run: () => void commitWork(g.key, usable) }]),
    { id: 'git-stage-its', label: m.stageIts, icon: 'plus', disabled: toStage.length === 0, run: () => void each(toStage, stage) },
    { id: 'git-unstage-its', label: m.unstageIts, disabled: toUnstage.length === 0, run: () => void each(toUnstage, unstage) },
    { id: 'git-discard-its', label: m.discardIts, icon: 'trash', danger: true, disabled: usable.length === 0, run: () => discardSheet(usable) },
    'sep'
  ];
}
