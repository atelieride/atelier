// Publish: a branch without an upstream goes to a remote (preselected when there is
// one) as <remote>/<branch>, tracked; "Open a pull request on GitHub after" only for a github.com remote, remembered.
import { useEffect, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { refreshFacts } from './actions';
import { loadGitPrefs } from './drafts';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { compareUrlFor, publish } from './sync';

export function PublishSheet({ root }: { root: string }) {
  const s = t.git.sync;
  const facts = useApp((x) => x.gitFacts[root]);
  const fallbackBranch = useApp((x) => x.scmRepos?.find((e) => e.root === root)?.status?.branch ?? null);
  const refRemotes = useApp((x) => x.scmRefs[root]?.remotes);
  useEffect(() => { void refreshFacts(root); }, [root]);
  const remotes = facts?.remotes.length ? facts.remotes : refRemotes ?? [];
  const branch = facts?.branch ?? fallbackBranch ?? '';
  const [remote, setRemote] = useState<string | null>(() => (remotes.length === 1 ? remotes[0]! : null));
  // Preselected only when there is exactly one: with several, which one is the user's call.
  useEffect(() => { if (remote === null && remotes.length === 1) setRemote(remotes[0]!); }, [remotes.join('\n')]);
  const [openPr, setOpenPr] = useState(() => loadGitPrefs().openPr);
  const github = useApp(() => compareUrlFor(root, remote)) !== null;

  const go = () => {
    if (!remote) return;
    closeGitSheet();
    void publish(root, remote, github && openPr);
  };
  const onRadioKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + remotes.length) % remotes.length;
    setRemote(remotes[next]!);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <SheetFrame title={s.publishTitle(branch)} icon="arrowUp">
      <p className="git-sheet-body">{remotes.length ? s.publishBody : s.noRemote}</p>
      {remotes.length > 0 && (
        <div className="git-sheet-fields">
          <span className="git-sheet-label">{s.remote}</span>
          <div className="git-sheet-remotes" role="radiogroup" aria-label={s.remote}>
            {remotes.map((r, i) => (
              <button key={r} type="button" role="radio" aria-checked={remote === r} tabIndex={remote === r || (remote === null && i === 0) ? 0 : -1}
                className={`git-sheet-remote mono ${remote === r ? 'is-on' : ''}`} onClick={() => setRemote(r)} onKeyDown={(e) => onRadioKey(e, i)}>{r}</button>
            ))}
          </div>
          <span className="git-sheet-label">{s.as}</span>
          <span className={`git-sheet-target mono ${remote ? '' : 'is-pending'}`}>{remote ?? s.remote.toLowerCase()}/{branch}</span>
        </div>
      )}
      {github && (
        <label className="git-sheet-check">
          <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.currentTarget.checked)} />
          {s.openPr}
        </label>
      )}
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" data-autofocus disabled={!remote} onClick={go}>{s.publishGo}</button>
        <button type="button" className="btn-ghost" onClick={closeGitSheet}>{s.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{s.keys}</span>
      </div>
    </SheetFrame>
  );
}
