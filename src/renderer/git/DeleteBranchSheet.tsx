// A branch git won't delete because its commits aren't merged anywhere: "feat/x has 3 commits
// that aren't merged anywhere", then Delete Anyway (branch -D, with an Undo for 30 s) or Cancel, which takes the focus.
import { t } from '../i18n/en';
import { shortRef } from '../scm/view';
import { branchDelete } from './actions';
import { SheetFrame, closeGitSheet } from './SheetFrame';

export function DeleteBranchSheet({ root, refName, message }: { root: string; refName: string; message?: string }) {
  const b = t.git.branch;
  const name = shortRef(refName);
  return (
    <SheetFrame title={b.deleteTitle(name)} icon="trash" tone="danger">
      <p className="git-sheet-body">{message ?? b.unmerged(name)}</p>
      <p className="git-sheet-note">{b.deleteNote}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-danger" onClick={() => { closeGitSheet(); void branchDelete(root, refName, true); }}>{b.deleteAnyway}</button>
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">esc</span>
      </div>
    </SheetFrame>
  );
}
