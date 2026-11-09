// "When viewing" fetches: a repository shown in the Source Control sidebar or the History tab asks main
// for a view fetch when it appears, when another one is selected and whenever the window comes back to the front. Main
// decides (setting, remote, 10 min, backoff, auth): asking often is cheap.
// Since 2026-11-08 the Changes panel counts as viewing too: while it is shown,
// every readable main repository of the window asks, so its ↓ stays fresh without opening Source Control.
import { useEffect } from 'react';
import type { RepoStatus } from '@shared/git';
import { isWorktree } from '../worktrees';
import { fetchRepo } from './actions';

export function useViewFetch(root: string | null, visible: boolean): void {
  useEffect(() => {
    if (!root || !visible) return;
    void fetchRepo(root, 'view');
    const onFocus = () => { void fetchRepo(root, 'view'); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [root, visible]);
}

/** The roots Changes asks for: readable main repositories, once each, in order (worktrees share their repo's objects). */
export function viewFetchRoots(repos: RepoStatus[]): string[] {
  return [...new Set(repos.filter((r) => !r.error && !isWorktree(r)).map((r) => r.root))];
}

/** Asks `ask` for every root now and on every focus of `target`; the returned function stops listening. */
export function watchViewFetches(roots: readonly string[], ask: (root: string) => void, target: EventTarget): () => void {
  if (!roots.length) return () => {};
  const all = () => { for (const root of roots) ask(root); };
  all();
  target.addEventListener('focus', all);
  return () => target.removeEventListener('focus', all);
}

/**
 * The roots as one string: the same while only the statuses change (every broadcast is a new array), another when the
 * set of readable main repositories does. The hook takes it, never an array, so it can't ask on every broadcast.
 */
export const viewFetchKey = (repos: RepoStatus[]): string => viewFetchRoots(repos).join('\n');

/** Changes' view fetches (`key`: viewFetchKey): on mount, when the key changes, and whenever the window comes back to the front. */
export function useViewFetches(key: string): void {
  useEffect(() => watchViewFetches(key ? key.split('\n') : [], (root) => { void fetchRepo(root, 'view'); }, window), [key]);
}
