// Switch with changes or with sessions working here: open the branch in a new worktree
// (preselected when a session works here: nothing moves under it), stash the changes and switch, or switch bringing
// them (git refuses when they clash; then the files are listed and the other two remain). A clean tree with a session
// in it: the worktree, or switch here anyway.
import { useMemo, useState, type KeyboardEvent } from 'react';
import { FileIcon } from '../components/FileIcon';
import { Icon, type IconName } from '../components/Icon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { shortRef } from '../scm/view';
import { switchTo } from './actions';
import { localName, workingNow } from './branches';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { idStyle } from '../avatar';

type Choice = 'worktree' | 'stash' | 'bring' | 'anyway';
const FILES_SHOWN = 5;

export function SwitchSheet({ root, refName, clash }: { root: string; refName: string; clash?: string[] }) {
  const b = t.git.branch;
  const ref = useApp((x) => x.scmRefs[root]?.refs.find((r) => r.name === refName));
  const repo = useApp((x) => x.repos.find((r) => r.root === root));
  const entry = useApp((x) => x.scmRepos?.find((e) => e.root === root));
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  const working = useMemo(() => workingNow(root), [root, terminals, attributions]);
  const target = ref ? localName(ref) : shortRef(refName);
  const name = repo?.name ?? entry?.name ?? root.split('/').pop() ?? root;
  const changed = repo ? repo.changes.length + (repo.truncated ?? 0) : entry?.status?.changes ?? 0;
  const dirty = changed > 0 || !!clash?.length;
  const choices: Choice[] = dirty ? ['worktree', 'stash', 'bring'] : ['worktree', 'anyway'];
  const [choice, setChoice] = useState<Choice>(() => (working.length ? 'worktree' : clash?.length ? 'stash' : dirty ? 'bring' : 'anyway'));
  const off = (c: Choice) => c === 'bring' && !!clash?.length;

  const meta: Record<Choice, { icon: IconName; label: string; sub: string }> = {
    worktree: { icon: 'worktree', label: b.choiceWorktree, sub: b.choiceWorktreeSub },
    stash: { icon: 'stash', label: b.choiceStash, sub: b.choiceStashSub },
    bring: { icon: 'swap', label: b.choiceBring, sub: b.choiceBringSub },
    anyway: { icon: 'swap', label: b.choiceAnyway, sub: b.choiceAnywaySub }
  };
  const go = () => {
    if (off(choice)) return;
    if (choice === 'worktree') { useApp.getState().setGitSheet({ kind: 'worktree', root, ref: refName }); return; }
    closeGitSheet();
    void switchTo(root, refName, choice === 'stash' ? 'stash' : choice === 'bring' ? 'bring' : 'none');
  };
  const onRadioKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Enter') { e.preventDefault(); go(); return; }
    if (!d) return;
    e.preventDefault();
    let next = i;
    do next = (next + d + choices.length) % choices.length; while (off(choices[next]!) && next !== i);
    setChoice(choices[next]!);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <SheetFrame title={b.switchTitle(target)} icon="swap" tone={working.length || clash?.length ? 'warn' : 'brand'}>
      <p className="git-sheet-body">{dirty ? b.changed(Math.max(changed, clash?.length ?? 0), name) : b.clean(name)}</p>
      {working.length > 0 && (
        <div className="git-notice is-live">
          <i className="git-notice-dot id-dot" style={idStyle(working[0]!.color)} />
          <span className="git-notice-text">{b.working(working.map((w) => w.title), name)}</span>
        </div>
      )}
      {!!clash?.length && (
        <>
          <p className="git-sheet-body is-clash">{b.clash(clash.length, target)}</p>
          <ul className="git-sheet-files">
            {clash.slice(0, FILES_SHOWN).map((rel) => {
              const file = rel.split('/').pop() ?? rel;
              const dir = rel.slice(0, rel.length - file.length);
              return (
                <li key={rel} className="git-sheet-file">
                  <FileIcon name={file} size={13} />
                  <span className="git-sheet-file-name">{file}</span>
                  {dir && <span className="git-sheet-file-dir mono">{dir}</span>}
                </li>
              );
            })}
            {clash.length > FILES_SHOWN && <li className="git-sheet-more">{t.git.sync.andMore(clash.length - FILES_SHOWN)}</li>}
          </ul>
        </>
      )}
      <div className="git-choices" role="radiogroup" aria-label={b.switchTitle(target)}>
        {choices.map((c, i) => (
          <button key={c} type="button" role="radio" aria-checked={choice === c} disabled={off(c)} tabIndex={choice === c ? 0 : -1}
            className={`git-choice ${choice === c ? 'is-on' : ''}`} data-autofocus={choice === c ? true : undefined}
            onClick={() => setChoice(c)} onDoubleClick={() => { setChoice(c); if (!off(c)) setTimeout(go, 0); }} onKeyDown={(e) => onRadioKey(e, i)}>
            <span className="git-choice-icon" aria-hidden="true"><Icon name={meta[c].icon} size={14} stroke={1.8} /></span>
            <span className="git-choice-main">
              <span className="git-choice-label">{meta[c].label}</span>
              <span className="git-choice-sub">{meta[c].sub}</span>
            </span>
            <span className="git-choice-mark" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" disabled={off(choice)} onClick={go}>
          {choice === 'worktree' ? b.goWorktree : choice === 'stash' ? b.goStash : b.goSwitch}
        </button>
        <button type="button" className="btn-ghost" onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{t.git.sync.keys}</span>
      </div>
    </SheetFrame>
  );
}
