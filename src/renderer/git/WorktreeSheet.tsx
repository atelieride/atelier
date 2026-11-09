// Open in New Worktree…: a folder inside the project, by default
// <repo>/.claude/worktrees/<branch slug> (Claude Code's --worktree convention), that must not exist yet; a warning when
// git doesn't ignore it (it would show up in the repository's changes; Atelier never edits .gitignore). A branch
// checked out already, or a remote one, gets a new branch from it. Done: a toast offers a Claude session there.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Icon } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { shortRef } from '../scm/view';
import { worktreeAdd, worktreeCheck } from './actions';
import { defaultWorktreePath, localName } from './branches';
import { nameError, useBranchNameCheck } from './BranchName';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { isAbsPath, isBelow } from '@shared/paths';

const DEBOUNCE_MS = 150;
type Place = { path: string; inside: boolean; exists: boolean; ignored: boolean } | null;

export function WorktreeSheet({ root, refName }: { root: string; refName?: string }) {
  const b = t.git.branch;
  const ref = useApp((x) => (refName ? x.scmRefs[root]?.refs.find((r) => r.name === refName) : undefined));
  const entry = useApp((x) => x.scmRepos?.find((e) => e.root === root));
  const project = useApp((x) => x.project?.realRoot ?? x.project?.root ?? '');
  const repoName = useApp((x) => x.repos.find((r) => r.root === root)?.name) ?? entry?.name ?? root.split('/').pop() ?? root;
  // A local branch checked out in none of the repository's working trees goes as it is; any other ref gets a new one.
  const busy = useApp((x) => !!ref && ref.kind === 'head' && (ref.current || !!x.scmRepos?.some((e) => e.common === entry?.common && e.status?.branch === ref.short)));
  const asIs = !!ref && ref.kind === 'head' && !busy;
  const [newName, setNewName] = useState(() => (ref && ref.kind === 'remote' ? localName(ref) : ''));
  const { check, clash, now } = useBranchNameCheck(root, newName);
  const base = entry?.worktreeOf ?? root;
  const branchFor = asIs ? ref.short : newName || (ref ? localName(ref) : 'worktree');
  const [path, setPath] = useState(() => defaultWorktreePath(base, branchFor));
  const [touched, setTouched] = useState(false);
  // The folder follows the new branch's name until it is edited by hand.
  useEffect(() => { if (!touched) setPath(defaultWorktreePath(base, branchFor)); }, [branchFor, base, touched]);
  const [place, setPlace] = useState<Place>(null);
  useEffect(() => {
    let alive = true;
    if (!isAbsPath(path)) { setPlace({ path, inside: false, exists: false, ignored: false }); return; }
    const id = setTimeout(() => { void worktreeCheck(root, path).then((c) => { if (alive) setPlace(c ? { path, ...c } : null); }); }, DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(id); };
  }, [root, path]);
  const known = place?.path === path ? place : null;
  const folderError = known && !known.inside ? b.outside : known?.exists ? b.folderExists : null;
  const nameErr = asIs ? null : nameError(check, newName, clash);
  const placeOk = !!known && known.inside && !known.exists;
  const ready = placeOk && (asIs || check === 'ok');
  const rel = project && isBelow(project, path) ? path.slice(project.length + 1) : path;
  const go = async () => {
    if (!placeOk || (!asIs && (await now()) !== 'ok')) return;
    closeGitSheet();
    void worktreeAdd({ root, path, ...(refName ? { ref: refName } : {}), ...(asIs ? {} : { newName }) });
  };
  const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } };
  return (
    <SheetFrame title={refName ? b.worktreeTitle(ref ? ref.short : shortRef(refName)) : b.worktreeNew} icon="worktree">
      <div className="git-sheet-fields">
        {asIs ? (
          <>
            <span className="git-sheet-label">{b.branch}</span>
            <span className="git-sheet-target mono">{ref.short}</span>
          </>
        ) : (
          <>
            <label className="git-sheet-label" htmlFor="git-wt-branch" data-tip={ref && busy ? b.newNameTip(ref.short) : undefined}>{b.newName}</label>
            <div className="git-field">
              <input id="git-wt-branch" className={`git-input mono ${nameErr ? 'is-invalid' : ''}`} data-autofocus value={newName} placeholder={b.namePlaceholder}
                aria-label={b.newName} aria-invalid={!!nameErr} spellCheck={false} autoComplete="off" onChange={(e) => setNewName(e.currentTarget.value)} onKeyDown={enter} />
              {nameErr && <span className="git-field-error" role="alert">{nameErr}</span>}
            </div>
          </>
        )}
        <label className="git-sheet-label" htmlFor="git-wt-folder">{b.folder}</label>
        <div className="git-field">
          <input id="git-wt-folder" className={`git-input mono ${folderError ? 'is-invalid' : ''}`} data-autofocus={asIs ? true : undefined} value={path}
            aria-label={b.folder} aria-invalid={!!folderError} spellCheck={false} autoComplete="off"
            onChange={(e) => { setTouched(true); setPath(e.currentTarget.value); }} onKeyDown={enter} />
          {folderError && <span className="git-field-error" role="alert">{folderError}</span>}
        </div>
      </div>
      {known && known.inside && !known.exists && !known.ignored && (
        <div className="git-notice is-warn git-notice-wrap"><Icon name="warning" size={12} stroke={2} /><span className="git-notice-text">{b.notIgnored(rel, repoName)}</span></div>
      )}
      <p className="git-sheet-note">{b.folderNote}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" disabled={!ready} onClick={() => void go()}>{b.createWorktree}</button>
        <button type="button" className="btn-ghost" onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{t.git.sync.keys}</span>
      </div>
    </SheetFrame>
  );
}
