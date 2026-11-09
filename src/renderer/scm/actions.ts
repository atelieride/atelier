// Source Control actions shared by the sidebar, the History tab, the palette and the menus. They open views and copy
// text; the only one that reaches a repository is fetching, which main runs.
import type { FetchOutcome, FetchReason, ScmFetchAnswer, ScmFetchState, ScmRef, ScmScope } from '@shared/scm';
import type { MenuItem } from '../menu-model';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { repoGitItems } from '../git/menu-items';
import { branchItems } from '../git/branches';
import { withScm } from './data';
import { loadScmPrefs } from './prefs';
import { shortRef } from './view';
import { kbd } from '../kbd';

const st = () => useApp.getState();

/** The First parent choice the History tab uses now (or the one saved for the project). */
function firstParent(): boolean {
  const h = st().historyTab;
  if (h && h.scope.kind === 'refs') return h.scope.firstParent;
  const root = st().project?.root;
  return root ? !!loadScmPrefs(root).firstParent : false;
}

export function showHistory(refs: 'all' | string = 'all', repo?: string): void {
  st().openHistory({ ...(repo ? { repo } : {}), scope: { kind: 'refs', refs, firstParent: firstParent() } });
}

export function showCompare(base: string, head: string, repo?: string): void {
  const scope: ScmScope = { kind: 'compare', base, head };
  st().openHistory({ ...(repo ? { repo } : {}), scope });
}

/** The selected repository's default branch as a ref to compare with (local first, else the remote one). */
export function defaultRef(root: string | null): { name: string; base: string } | null {
  const refs = root ? st().scmRefs[root] : undefined;
  const def = refs?.defaultBranch;
  if (!refs || !def) return null;
  const local = refs.refs.find((r) => r.kind === 'head' && r.short === def.base);
  const remote = refs.refs.find((r) => r.kind === 'remote' && r.short === def.ref);
  const r = local ?? remote;
  return r ? { name: r.name, base: def.base } : null;
}

export function compareWithDefault(ref: string, repo?: string): void {
  const def = defaultRef(repo ?? st().scmRepo);
  if (def && def.name !== ref) showCompare(def.name, ref, repo);
  else showHistory(ref, repo);
}

export function copy(text: string, toast?: string): void {
  void copyText(text).then((ok) => { if (ok && toast) st().showToast(toast, undefined, 'info'); });
}

/**
 * Fetches a repository. A view fetch runs only past main's gates and never says anything; a manual
 * one that fails says why, with Try Again. Answers how it ended (null: it didn't run, or the call failed).
 */
export async function fetchRepo(root: string, reason: FetchReason): Promise<FetchOutcome | null> {
  const f = t.scm.fetch;
  let a: ScmFetchAnswer;
  try { a = await window.atelier.scm.fetchRepo(root, reason); } catch (err) {
    if (reason === 'manual') st().showToast(f.errorToast((err as Error).message));
    return null;
  }
  if (a.state) st().setScmFetch(a.state);
  if (reason !== 'manual' || !a.outcome || a.outcome === 'ok') return a.outcome ?? null;
  const msg = a.message ?? '';
  const text = a.outcome === 'network' ? f.network : a.outcome === 'busy' ? f.busy
    : a.outcome === 'auth' ? (msg ? f.authToast(msg) : f.signIn) : (msg ? f.errorToast(msg) : f.failedPlain);
  st().showToast(text, { label: f.tryAgain, run: () => void fetchRepo(root, 'manual') });
  return a.outcome;
}

/** Fetch All Repositories: every repository of the project with a remote, then one toast. */
export async function fetchAll(): Promise<void> {
  const f = t.scm.fetch;
  const outs = await window.atelier.scm.fetchAll().catch((): FetchOutcome[] | null => null);
  if (!outs) return;
  const failed = outs.filter((o) => o !== 'ok').length;
  if (!outs.length) st().showToast(f.noneToFetch, undefined, 'info');
  else if (!failed) st().showToast(f.allDone(outs.length), undefined, 'info');
  else st().showToast(f.allFailed(failed, outs.length));
}

/** The selected repository, fetched by hand (palette, Git menu, sidebar ↻). */
export function fetchSelected(): void {
  void withScm(() => {
    const root = st().scmRepo;
    if (!root) return;
    if (!mayFetch(root)) { st().showToast(t.scm.fetch.noRemote, undefined, 'info'); return; }
    void fetchRepo(root, 'manual');
  });
}

/** Whether a repository can be fetched: a remote (from its refs, else an upstream in its status). */
export function mayFetch(root: string): boolean {
  const refs = st().scmRefs[root];
  if (refs) return refs.hasRemote;
  const entry = st().scmRepos?.find((e) => e.root === root);
  const status = entry?.status ?? st().repos.find((r) => r.root === root);
  return !!status?.upstream;
}

/** A repository's fetch state (shared by its worktrees). */
export function fetchStateOf(root: string): ScmFetchState | undefined {
  const common = st().scmRepos?.find((e) => e.root === root)?.common;
  return common ? st().scmFetch[common] : undefined;
}

/**
 * The context menu of a repository (switcher, Changes' repo header). `staging`: Changes' header, where Stage All,
 * Unstage All, Commit… and Discard All Changes… come first.
 */
export function repoMenu(root: string, o: { staging?: boolean } = {}): MenuItem[] {
  return [
    ...(o.staging ? repoGitItems(root) : []),
    { id: 'show-history', label: t.scm.menu.showHistory, icon: 'git', run: () => showHistory('all', root) },
    ...(mayFetch(root) ? [{ id: 'fetch', label: t.scm.fetch.label, icon: 'fetch' as const, run: () => void fetchRepo(root, 'manual') }] : [])
  ];
}

/**
 * The context menu of a branch or tag row (sidebar, ref picker). `git`: the sidebar's working tree, for the git items
 * first (Switch, New Branch from Here…, Open in New Worktree…, Rename…, Delete Branch…).
 */
export function refMenu(ref: ScmRef, git?: { root: string; elsewhere: boolean; rename?: () => void }): MenuItem[] {
  const m = t.scm.menu;
  const def = defaultRef(st().scmRepo);
  return [
    ...(git ? branchItems(git.root, ref, git) : []),
    { id: 'show-history', label: m.showHistory, icon: 'git', run: () => showHistory(ref.name) },
    ...(def && def.name !== ref.name ? [{ id: 'compare-default', label: m.compareDefault(def.base), icon: 'compare' as const, hint: kbd('⌥-click'), run: () => showCompare(def.name, ref.name) }] : []),
    { id: 'compare-with', label: m.compareWith, icon: 'compare', run: () => st().setRefPicker({ mode: 'compare', head: ref.name }) },
    'sep',
    { id: 'copy-name', label: m.copyName, icon: 'copy', run: () => copy(shortRef(ref.name)) },
    { id: 'copy-sha', label: m.copySha, icon: 'copy', run: () => copy(ref.oid, t.scm.history.copied(ref.oid.slice(0, 7))) }
  ];
}
