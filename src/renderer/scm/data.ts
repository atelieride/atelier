// Source Control data in the renderer: the switcher's entries and the selected
// repository's refs, loaded on demand and again when main says something changed. Nothing is loaded until the view
// is first used.
import { useEffect, useState } from 'react';
import type { RepoStatus } from '@shared/git';
import type { ScmEvent, ScmRefs } from '@shared/scm';
import { useApp } from '../store';
import type { LiveSession } from './view';

const listeners = new Set<(e: ScmEvent) => void>();
let reposTimer: ReturnType<typeof setTimeout> | null = null;
let reposAsked = 0;

/** The switcher's entries with their statuses (a newer answer wins over an older one still in flight). */
export function loadRepos(): Promise<void> {
  const n = ++reposAsked;
  return window.atelier.scm.repos().then((list) => {
    if (n !== reposAsked) return;
    useApp.getState().setScmRepos(list);
    // Fetches that ran (or are running) before this window listed the repositories.
    void window.atelier.scm.fetchStates().then((states) => { for (const s of states) useApp.getState().setScmFetch(s); }).catch(() => {});
  }).catch(() => {});
}

/** Runs once the entries (and the selected repository's refs) are known: commands from the palette or a menu. */
export async function withScm(fn: () => void): Promise<void> {
  if (useApp.getState().scmRepos === null) await loadRepos();
  const root = useApp.getState().scmRepo;
  if (root && !useApp.getState().scmRefs[root]) await loadRefs(root);
  fn();
}

function loadReposSoon(ms = 400): void {
  if (reposTimer) clearTimeout(reposTimer);
  reposTimer = setTimeout(() => { reposTimer = null; loadRepos(); }, ms);
}

const asked = new Map<string, number>();
/** A repository's refs, kept in the store; null when the call fails. */
export async function loadRefs(root: string): Promise<ScmRefs | null> {
  const n = (asked.get(root) ?? 0) + 1;
  asked.set(root, n);
  const refs = await window.atelier.scm.refs(root).catch(() => null);
  if (refs && asked.get(root) === n) useApp.getState().setScmRefs(root, refs);
  return refs;
}

/** Called for every Source Control event (the History tab reloads its list from it). */
export function onScmEvent(cb: (e: ScmEvent) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The repositories whose git common dir an event names. */
export function rootsOf(e: ScmEvent): string[] {
  return (useApp.getState().scmRepos ?? []).filter((x) => x.common === e.common).map((x) => x.root);
}

/** Live wiring, once per window: events and git statuses refresh what is loaded (only once the view was used). */
export function installScm(): () => void {
  const offScm = window.atelier.on.scm((e) => {
    const st = useApp.getState();
    if (st.scmRepos === null) return;
    if (e.what === 'head') loadReposSoon(150);
    const shown = new Set([st.scmRepo, st.historyTab?.repo].filter((x): x is string => !!x));
    for (const root of rootsOf(e)) if (shown.has(root) || st.scmRefs[root]) void loadRefs(root);
    for (const cb of listeners) cb(e);
  });
  // The entries are listed once, with the project's first git statuses: session menus ("Show History of <branch>",
  // hidden worktrees included) and a History tab opened from Changes need them; then they follow every status.
  let listed = false;
  const offGit = window.atelier.on.git(() => {
    if (!listed) { listed = true; if (useApp.getState().scmRepos === null) { void loadRepos(); return; } }
    if (useApp.getState().scmRepos !== null) loadReposSoon();
  });
  const offFetch = window.atelier.on.scmFetch((s) => useApp.getState().setScmFetch(s));
  return () => { offScm(); offGit(); offFetch(); if (reposTimer) clearTimeout(reposTimer); };
}

/**
 * A working tree's status: Changes' own when it watches that repo, else main's (a hidden-folder worktree), read again
 * whenever the switcher's entry for it changes.
 */
export function useRepoStatus(root: string): RepoStatus | undefined {
  const watched = useApp((s) => s.repos.find((r) => r.root === root));
  const entry = useApp((s) => JSON.stringify(s.scmRepos?.find((e) => e.root === root)?.status ?? null));
  const [own, setOwn] = useState<RepoStatus | null>(null);
  useEffect(() => {
    if (watched) return;
    let alive = true;
    void window.atelier.scm.status(root).then((s) => { if (alive) setOwn(s); }).catch(() => {});
    return () => { alive = false; };
  }, [root, !!watched, entry]);
  return watched ?? own ?? undefined;
}

/** Claude sessions with the folder they work in and their last activity (the switcher's avatars and order). */
export function liveSessions(): LiveSession[] {
  return useApp.getState().terminals.filter((x) => x.session).map((x) => ({ id: x.id, title: x.title, color: x.color, cwd: x.cwd || x.session?.cwd || '', at: x.session?.updatedAt ?? x.createdAt }));
}
