// Changes when everything is clean: one quiet line, then each repository as a
// row — its name flush with the check, its sync arrows right after it, its branch
// where a group's count ends — and its worktrees under it. Nothing here is a control: no hover.

import { useRef, useState } from 'react';
import type { RepoStatus } from '@shared/git';
import { t } from '../i18n/en';
import { CHANGES_CAP, capShown } from '../changes';
import { branchLabel, toMerge, type WtView } from '../worktrees';
import { Icon } from './Icon';
import { SyncCounts } from './SyncCounts';

/**
 * hidden: changes This workspace hides (other workspaces' sessions made them): the line says so instead of "clean".
 * A dozen repositories get their row; the rest wait behind one row that shows them (repositories a live session works
 * in, `live`, always get theirs).
 */
export function CleanState({ repos: all, worktreesOf, hidden = 0, live = new Set() }: { repos: RepoStatus[]; worktreesOf: (root: string) => WtView[]; hidden?: number; live?: ReadonlySet<string> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { shown: repos, more } = open ? { shown: all, more: 0 } : capShown(all, CHANGES_CAP, (r) => live.has(r.root));
  // The row that showed them goes away under the focus: it moves to the first repository it showed.
  const showAll = () => { const from = repos.length; setOpen(true); requestAnimationFrame(() => box.current?.querySelectorAll<HTMLElement>('.clean-row:not(.is-wt)')[from]?.focus()); };
  return (
    <div className="clean-state" ref={box}>
      {hidden > 0 ? (
        <span className="clean-note" data-tip={t.cleanHiddenTip(hidden)}>
          <Icon name="workspace" size={12} stroke={1.8} />
          <span className="clean-note-text">{t.cleanHidden}{' '}<span className="clean-note-n">{t.cleanHiddenCount(hidden)}</span></span>
        </span>
      ) : (
        <span className="clean-note is-clean">
          <Icon name="check" size={12} stroke={2.4} />
          <span className="clean-note-text">
            {all.length === 1 ? t.cleanOne : <>{t.cleanAll}{' '}<span className="clean-note-n">{t.cleanCount(all.length)}</span></>}
          </span>
        </span>
      )}
      {repos.map((r) => [
        <span key={r.root} className="clean-row" tabIndex={-1}>
          <span className="clean-name">{r.name}</span>
          <SyncCounts status={r} />
          <span className="clean-branch mono"><Icon name="git" size={10} stroke={1.8} /><span className="clean-branch-text">{r.detached ? t.detached : r.branch ?? '—'}</span></span>
        </span>,
        ...worktreesOf(r.root).map((w) => (
          <span key={w.status.root} className="clean-row is-wt" data-tip={t.wt.headTip(w.status.root, branchLabel(w.status), null)}>
            <Icon name="branchOff" size={11} stroke={1.9} />
            <span className="clean-name mono">{w.name}</span>
            <SyncCounts status={w.status} />
            {w.state === 'merge' && <span className="clean-ahead mono">{t.wt.toMerge(toMerge(w.status))}</span>}
          </span>
        ))
      ])}
      {more > 0 && <button type="button" className="clean-more" onClick={showAll}>{t.moreCleanRepos(more)}</button>}
    </div>
  );
}
