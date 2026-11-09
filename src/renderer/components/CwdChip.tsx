import type { TerminalInfo } from '@shared/protocol';
import { relativeCwd, truncateLeft } from '../folders';
import { useApp } from '../store';
import { realPath, worktreeAt } from '../worktrees';
import { Icon } from './Icon';

/**
 * Where a session or terminal runs, when it is not the project root: "api/", "…/apps/web/" (full path on hover). In a
 * linked worktree, the worktree's name with its glyph, not its long hidden path.
 * Kept short so the title, which shrinks first, still shows.
 */
export function CwdChip({ term }: { term: TerminalInfo }) {
  const project = useApp((s) => s.project);
  // The same folder the tab tooltip shows: Claude's own when known.
  const cwd = term.session?.cwd ?? term.cwd;
  const wt = useApp((s) => worktreeAt(s.repos, realPath(cwd, s.project))?.name ?? null);
  if (wt) return <span className="cwd-chip is-wt mono" data-tip={cwd}><Icon name="branchOff" size={10} stroke={1.9} /><span className="cwd-wt-name">{truncateLeft(wt, 14)}</span></span>;
  const rel = relativeCwd(cwd, project?.root, project?.realRoot);
  if (!rel) return null;
  // The chip is right-to-left only to put its ellipsis at the start; the path inside reads left to right. A crowded row
  // shows the folder glyph alone.
  return <span className="cwd-chip mono" data-tip={cwd}><span className="chip-glyph"><Icon name="folderOpen" size={10} stroke={1.9} /></span><bdi dir="ltr">{truncateLeft(rel, 14)}</bdi></span>;
}
