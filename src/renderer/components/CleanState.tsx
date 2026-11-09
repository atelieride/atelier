// Changes when everything is clean: one quiet line, then each repository as a
// row — its name flush with the check, its sync arrows right after it, its branch
// where a group's count ends — and its worktrees under it. Nothing here is a control: no hover.

import type { RepoStatus } from '@shared/git';
import { t } from '../i18n/en';
import { branchLabel, toMerge, type WtView } from '../worktrees';
import { Icon } from './Icon';
import { SyncCounts } from './SyncCounts';

/** hidden: changes This workspace hides (other workspaces' sessions made them): the line says so instead of "clean". */
export function CleanState({ repos, worktreesOf, hidden = 0 }: { repos: RepoStatus[]; worktreesOf: (root: string) => WtView[]; hidden?: number }) {
  return (
    <div className="clean-state">
      {hidden > 0 ? (
        <span className="clean-note" data-tip={t.cleanHiddenTip(hidden)}>
          <Icon name="workspace" size={12} stroke={1.8} />
          <span className="clean-note-text">{t.cleanHidden}{' '}<span className="clean-note-n">{t.cleanHiddenCount(hidden)}</span></span>
        </span>
      ) : (
        <span className="clean-note is-clean">
          <Icon name="check" size={12} stroke={2.4} />
          <span className="clean-note-text">
            {repos.length === 1 ? t.cleanOne : <>{t.cleanAll}{' '}<span className="clean-note-n">{t.cleanCount(repos.length)}</span></>}
          </span>
        </span>
      )}
      {repos.map((r) => [
        <span key={r.root} className="clean-row">
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
    </div>
  );
}
