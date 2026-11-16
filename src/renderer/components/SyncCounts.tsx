// A working tree's sync arrows in Changes: ↓ to pull, ↑ to push, in Source
// Control's colors, right after its name. Display only: a tooltip, never a control (no hover, focus or click). Read as
// one label ("1 to pull, 2 to push"): role img, or a screen reader would skip the label and read the glyphs.
// PullCounts is the exception: with git actions on, its ↓ pulls.
import { useLayoutEffect, useRef } from 'react';
import type { RepoStatus } from '@shared/git';
import { t } from '../i18n/en';
import { startPull } from '../git/sync';
import { runningLabel } from '../scm/all-view';
import { useApp } from '../store';
import { syncLabel, syncOf, syncTip } from '../sync';

type Status = Pick<RepoStatus, 'branch' | 'upstream' | 'upstreamGone' | 'ahead' | 'behind' | 'error'>;

export function SyncCounts({ status }: { status: Status }) {
  const v = syncOf(status);
  if (!v) return null;
  return (
    <span className="sync-counts mono" role="img" data-tip={syncTip(v)} aria-label={syncLabel(v)}>
      {v.behind > 0 && <span className="git-sync-behind">↓{v.behind}</span>}
      {v.ahead > 0 && <span className="git-sync-ahead">↑{v.ahead}</span>}
    </span>
  );
}

/**
 * The arrows with git actions on: the ↓ pulls — Source Control's own Pull, which asks first when the branch diverged
 * or a live session's files would change, and offers Stash and Pull when the working tree's changes would be
 * overwritten. The ↑ stays a label. A pull or sync running there puts a spinner in the arrow's place; any other op on
 * that working tree turns it off, saying why. Without commits to pull, or in Read-only, these are SyncCounts.
 * `inside`: in a header that is itself a button (it folds its group, opens a comparison): a click target that never
 * does what the header does, as the session avatars are, never a button in a button; the header's context menu has
 * Pull for the keyboard.
 */
export function PullCounts({ root, status, inside = false }: { root: string; status: Status; inside?: boolean }) {
  const writes = useApp((s) => s.settings.gitActions === 'on');
  const op = useApp((s) => Object.values(s.gitOps).find((o) => o.root === root && o.op !== 'stage' && o.op !== 'unstage')?.op ?? null);
  const v = syncOf(status);
  const pullable = writes && !!v && v.behind > 0;
  // A pull that went through takes the ↓ away from under the focus: the focus goes back to its row or chip, unless it
  // moved on.
  const row = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (pullable || !row.current) return;
    if (row.current.isConnected && (!document.activeElement || document.activeElement === document.body)) row.current.focus({ preventScroll: true });
    row.current = null;
  }, [pullable]);
  if (!v || !pullable) return <SyncCounts status={status} />;

  const pulling = op === 'pull' || op === 'sync';
  const off = op && !pulling ? `${t.git.sync.pull} · ${runningLabel(op)}` : null;
  const label = pulling ? runningLabel(op) : off ?? t.git.sync.tip(v.behind, 0, v.upstream);
  const className = `sync-pull git-sync-behind${pulling ? ' is-busy' : off ? ' is-off' : ''}`;
  const arrow = <>{pulling ? <i className="git-spin" aria-hidden="true" /> : '↓'}{v.behind}</>;
  return (
    <span className="sync-counts mono has-pull" data-tip={syncTip(v)}>
      {inside ? (
        <span className={className} data-tip={label} onClick={(e) => { e.stopPropagation(); if (!op) void startPull(root); }}>{arrow}</span>
      ) : (
        <button type="button" className={className} aria-busy={pulling || undefined} aria-disabled={off ? true : undefined}
          data-tip={label} aria-label={label}
          onClick={(e) => {
            if (op) return;
            row.current = e.currentTarget.closest<HTMLElement>('.clean-row, .chip-static');
            void startPull(root);
          }}>
          {arrow}
        </button>
      )}
      {v.ahead > 0 && <span className="git-sync-ahead" role="img" aria-label={t.scm.all.toPush(v.ahead)}>↑{v.ahead}</span>}
    </span>
  );
}
