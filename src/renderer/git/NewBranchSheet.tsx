// New Branch…: a name checked as it is typed (check-ref-format through main), "from" HEAD or the
// ref it was asked on, and "Switch to it" (on). Enter creates once the name is good.
import { useState } from 'react';
import { t } from '../i18n/en';
import { radioNext } from '../radio';
import { useApp } from '../store';
import { shortRef } from '../scm/view';
import { branchCreate } from './actions';
import { nameError, useBranchNameCheck } from './BranchName';
import { SheetFrame, closeGitSheet } from './SheetFrame';

export function NewBranchSheet({ root, from }: { root: string; from?: string }) {
  const b = t.git.branch;
  const head = useApp((x) => x.scmRefs[root]?.head.branch ?? x.gitFacts[root]?.branch ?? null);
  const [name, setName] = useState('');
  const [base, setBase] = useState<string | null>(from ?? null);
  const [switchToIt, setSwitchToIt] = useState(true);
  const { check, clash, now } = useBranchNameCheck(root, name);
  const error = nameError(check, name, clash);
  const go = async () => {
    if ((await now()) !== 'ok') return;
    closeGitSheet();
    void branchCreate({ root, name, ...(base ? { from: base } : {}), switch: switchToIt });
  };
  const bases: (string | null)[] = from ? [null, from] : [null];
  return (
    <SheetFrame title={b.newTitle} icon="branchOff">
      <div className="git-sheet-fields">
        <label className="git-sheet-label" htmlFor="git-new-branch-name">{b.name}</label>
        <div className="git-field">
          <input id="git-new-branch-name" className={`git-input mono ${error ? 'is-invalid' : ''}`} data-autofocus value={name} placeholder={b.namePlaceholder}
            aria-label={b.name} aria-invalid={!!error} spellCheck={false} autoComplete="off"
            onChange={(e) => setName(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }} />
          {error && <span className="git-field-error" role="alert">{error}</span>}
        </div>
        <span className="git-sheet-label">{b.from}</span>
        {/* A radio group: one Tab stop (the checked one), arrows move the choice (radio.ts). */}
        <div className="git-sheet-remotes" role="radiogroup" aria-label={b.from}>
          {bases.map((x, i) => (
            <button key={x ?? 'HEAD'} type="button" role="radio" aria-checked={base === x} tabIndex={base === x ? 0 : -1}
              className={`git-sheet-remote mono ${base === x ? 'is-on' : ''}`} onClick={() => setBase(x)}
              onKeyDown={(e) => {
                // By position: HEAD is null, which radioNext keeps for "not an arrow".
                const next = radioNext(bases.map((_, j) => j), i, e.key);
                if (next === null) return;
                e.preventDefault();
                setBase(bases[next] ?? null);
                (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
              }}>
              {x ? shortRef(x) : b.head(head)}
            </button>
          ))}
        </div>
      </div>
      <label className="git-sheet-check">
        <input type="checkbox" checked={switchToIt} onChange={(e) => setSwitchToIt(e.currentTarget.checked)} />
        {b.switchToIt}
      </label>
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" disabled={check !== 'ok'} onClick={() => void go()}>{b.create}</button>
        <button type="button" className="btn-ghost" onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{t.git.sync.keys}</span>
      </div>
    </SheetFrame>
  );
}
