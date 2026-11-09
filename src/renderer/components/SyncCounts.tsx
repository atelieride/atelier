// A working tree's sync arrows in Changes: ↓ to pull, ↑ to push, in Source
// Control's colors, right after its name. Display only: a tooltip, never a control (no hover, focus or click). Read as
// one label ("1 to pull, 2 to push"): role img, or a screen reader would skip the label and read the glyphs.
import type { RepoStatus } from '@shared/git';
import { syncLabel, syncOf, syncTip } from '../sync';

export function SyncCounts({ status }: { status: Pick<RepoStatus, 'branch' | 'upstream' | 'upstreamGone' | 'ahead' | 'behind' | 'error'> }) {
  const v = syncOf(status);
  if (!v) return null;
  return (
    <span className="sync-counts mono" role="img" data-tip={syncTip(v)} aria-label={syncLabel(v)}>
      {v.behind > 0 && <span className="git-sync-behind">↓{v.behind}</span>}
      {v.ahead > 0 && <span className="git-sync-ahead">↑{v.ahead}</span>}
    </span>
  );
}
