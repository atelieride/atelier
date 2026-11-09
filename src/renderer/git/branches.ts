// Branches and stashes from Source Control: who works in a working tree (a switch asks
// first then), a new worktree's default folder, a stash's file count, the branch and stash rows' git items, and the
// openers the sidebar, the menus and the palette share. Main checks and runs every op.
import type { Attribution } from '@shared/attribution';
import type { FileChange } from '@shared/git';
import type { TerminalInfo } from '@shared/protocol';
import type { ScmRef, ScmStash } from '@shared/scm';
import type { MenuItem } from '../menu-model';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { branchDelete, stashApply, stashDrop, switchTo } from './actions';
import { inTurn, liveFiles, type LiveBy } from './live';
import { isBelow } from '@shared/paths';

const st = () => useApp.getState();
const on = () => st().settings.gitActions === 'on';
const b = t.git.branch;

/** A second click this soon makes a double-click (the row's Switch). */
export const DOUBLE_CLICK_MS = 250;

/**
 * A branch row's clicks: a click shows its History; where a double-click switches (`delay`), the History waits
 * until no second click follows, so switching never opens it on the way. `detail`: the click's count (MouseEvent.detail).
 */
export function rowClicks(o: { single: () => void; delay: () => boolean }): (detail: number) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (detail) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (detail >= 2) return;
    if (!o.delay()) { o.single(); return; }
    timer = setTimeout(() => { timer = null; o.single(); }, DOUBLE_CLICK_MS);
  };
}

/** The working tree holding `path`: the deepest of `roots` (a nested repository or a linked worktree is its own). */
export function deepestRoot(path: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const r of roots) if ((path === r || isBelow(r, path)) && (!best || r.length > best.length)) best = r;
  return best;
}

/**
 * The sessions working in a working tree: in their turn with their folder there, or editing its files now (live
 * files), each once, in order of appearance.
 */
export function workingIn(root: string, roots: readonly string[], terminals: readonly Pick<TerminalInfo, 'id' | 'cwd' | 'title' | 'color' | 'session' | 'work'>[], attributions: readonly Attribution[]): LiveBy[] {
  const all = roots.includes(root) ? roots : [...roots, root];
  const out = new Map<string, LiveBy>();
  for (const x of terminals) {
    const cwd = x.cwd || x.session?.cwd || '';
    if (inTurn(x) && cwd && deepestRoot(cwd, all) === root) out.set(x.id, { terminalId: x.id, title: x.title, color: x.color });
  }
  for (const [path, by] of liveFiles(terminals, attributions)) {
    if (!out.has(by.terminalId) && deepestRoot(path, all) === root) out.set(by.terminalId, by);
  }
  return [...out.values()];
}

/** Every working tree Atelier knows of now (Changes' and Source Control's). */
export function knownRoots(): string[] {
  return [...new Set([...st().repos.map((r) => r.root), ...(st().scmRepos ?? []).map((e) => e.root)])];
}

/** The sessions working in `root` now. */
export const workingNow = (root: string): LiveBy[] => workingIn(root, knownRoots(), st().terminals, st().attributions);

/** A branch as a folder name: anything but letters, digits, `.`, `_`, `-` becomes one `-`; never hidden, never empty. */
export function worktreeSlug(branch: string): string {
  const slug = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'worktree';
}

/** `<repo>/.claude/worktrees/<slug>`: the convention Claude Code's --worktree uses. */
export function defaultWorktreePath(base: string, branch: string): string {
  return `${base}/.claude/worktrees/${worktreeSlug(branch)}`;
}

/** A branch's local name: a remote branch without its remote (what a switch tracks it as). */
export function localName(ref: Pick<ScmRef, 'kind' | 'short' | 'remote'>): string {
  return ref.kind === 'remote' && ref.remote ? ref.short.slice(ref.remote.length + 1) : ref.short;
}

/** The files a stash would take: every change with new files, tracked ones without, the staged ones with --staged. */
export function stashFileCount(changes: readonly Pick<FileChange, 'kind' | 'stage'>[], o: { untracked: boolean; staged: boolean }): number {
  if (o.staged) return changes.filter((c) => c.stage !== 'none').length;
  return o.untracked ? changes.length : changes.filter((c) => c.kind !== '?').length;
}

/**
 * Switch: with a session working in that tree the sheet asks first; otherwise straight to main, which switches a
 * clean tree and answers a dirty one with the sheet's choices (actions.switchTo opens it).
 */
export async function startSwitch(root: string, ref: string): Promise<void> {
  if (!on()) return;
  if (workingNow(root).length) { st().setGitSheet({ kind: 'switch', root, ref }); return; }
  await switchTo(root, ref, 'none');
}

/** New Branch…: from HEAD, or from the ref it was asked on. */
export function openNewBranch(root: string, from?: string): void {
  if (on()) st().setGitSheet({ kind: 'newBranch', root, ...(from ? { from } : {}) });
}

/** Open in New Worktree… for a ref. */
export function openWorktree(root: string, ref?: string): void {
  if (on()) st().setGitSheet({ kind: 'worktree', root, ...(ref ? { ref } : {}) });
}

/** Stash Changes… for a working tree, by default the one Source Control shows. */
export function openStash(root: string | null = st().scmRepo): void {
  if (on() && root) st().setGitSheet({ kind: 'stash', root });
}

/** The ref picker in its "Switch to Branch…" mode. */
export function openSwitchPicker(): void {
  if (on()) st().setRefPicker({ mode: 'switch' });
}

/**
 * A branch or tag row's git items, before today's items. `elsewhere`: checked out in another worktree (no
 * Rename, no Delete); the current branch has no Switch and no Delete; a remote branch switches by tracking; a tag only
 * branches. `rename`: the row's inline rename. Read-only: none.
 */
export function branchItems(root: string, ref: ScmRef, o: { elsewhere: boolean; rename?: () => void }): MenuItem[] {
  if (!on()) return [];
  const newFrom: MenuItem = { id: 'git-new-branch', label: b.newBranchFrom, icon: 'branchOff', run: () => openNewBranch(root, ref.name) };
  if (ref.kind === 'tag') return [newFrom, 'sep'];
  const local = ref.kind === 'head';
  return [
    ...(ref.current ? [] : [{ id: 'git-switch', label: b.switchTo(localName(ref)), icon: 'swap' as const, run: () => void startSwitch(root, ref.name) }]),
    newFrom,
    { id: 'git-worktree', label: b.worktree, icon: 'worktree', run: () => openWorktree(root, ref.name) },
    ...(local && !o.elsewhere && o.rename ? [{ id: 'git-rename', label: b.rename, icon: 'edit' as const, run: o.rename }] : []),
    ...(local && !o.elsewhere && !ref.current ? [{ id: 'git-delete', label: b.remove, icon: 'trash' as const, danger: true, run: () => void branchDelete(root, ref.name) }] : []),
    'sep'
  ];
}

/** A stash row's items, each on that exact stash (main checks its index still holds that oid). */
export function stashItems(root: string, s: ScmStash): MenuItem[] {
  if (!on()) return [];
  const m = t.git.stash;
  const at = { root, index: s.index, oid: s.oid };
  return [
    { id: 'git-stash-apply', label: m.apply, icon: 'stash', run: () => void stashApply({ ...at, pop: false, message: s.message }) },
    { id: 'git-stash-pop', label: m.pop, run: () => void stashApply({ ...at, pop: true, message: s.message }) },
    { id: 'git-stash-drop', label: m.drop, icon: 'trash', danger: true, run: () => void stashDrop(at) },
    'sep',
    { id: 'git-stash-copy', label: m.copyMessage, icon: 'copy', run: () => void copyText(s.message).then((ok) => { if (ok) st().showToast(m.copied, undefined, 'info'); }) }
  ];
}
