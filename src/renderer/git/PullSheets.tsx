// Pull's questions: a diverged branch, "Rebase your 2 commits on origin/main?" (a conflicting
// rebase is aborted by main, nothing half-done); and incoming changes to files a live session is changing, "origin/main
// changes 2 files auth-refactor is working on", Pull Anyway or Cancel.
import { useMemo } from 'react';
import { idStyle, initialOf } from '../avatar';
import { FileIcon } from '../components/FileIcon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { guardedPull, liveNow, overlapFiles, runPull, sentence } from './sync';

const FILES_SHOWN = 5;

function useRepo(root: string) {
  const entry = useApp((x) => x.scmRepos?.find((e) => e.root === root)?.status ?? null);
  const watched = useApp((x) => x.repos.find((r) => r.root === root));
  const upstream = useApp((x) => x.gitFacts[root]?.upstream) ?? entry?.upstream ?? watched?.upstream ?? t.git.sync.theRemote;
  return { ahead: entry?.ahead ?? watched?.ahead ?? 0, behind: entry?.behind ?? watched?.behind ?? 0, upstream };
}

/**
 * `byResult`: opened by git's refusal (a pull that couldn't fast-forward), not by a click: Cancel takes the focus, so
 * an Enter meant for something else never rebases. Opened from Pull or Sync, Rebase has it (↵ confirms).
 */
export function PullRebaseSheet({ root, sync, byResult = false }: { root: string; sync: boolean; byResult?: boolean }) {
  const s = t.git.sync;
  const { ahead, behind, upstream } = useRepo(root);
  return (
    <SheetFrame title={s.rebaseTitle(Math.max(ahead, 1), upstream)} icon="branchOff">
      <p className="git-sheet-body">{sentence(s.rebaseBody(Math.max(behind, 1), upstream))}</p>
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" data-autofocus={byResult ? undefined : true} onClick={() => { closeGitSheet(); void guardedPull(root, { rebase: true, sync }); }}>{sync ? s.rebaseAndPush : s.rebaseGo}</button>
        <button type="button" className="btn-ghost" data-autofocus={byResult ? true : undefined} onClick={closeGitSheet}>{s.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{s.keys}</span>
      </div>
    </SheetFrame>
  );
}

export function PullOverlapSheet({ root, files, rebase, sync }: { root: string; files: string[]; rebase: boolean; sync: boolean }) {
  const s = t.git.sync;
  const { upstream } = useRepo(root);
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  // Who, from the live files now (a session that ended meanwhile drops out of the names, its files stay listed).
  const live = useMemo(() => liveNow(), [terminals, attributions]);
  const who = overlapFiles(root, files, live).who;
  return (
    <SheetFrame title={sentence(s.overlapTitle(upstream, files.length, who.length ? who.map((w) => w.title) : ['a session']))} icon="warning" tone="warn">
      <p className="git-sheet-body">{s.overlapBody}</p>
      <ul className="git-sheet-files">
        {files.slice(0, FILES_SHOWN).map((rel) => {
          const by = live.get(`${root}/${rel}`);
          const name = rel.split('/').pop() ?? rel;
          const dir = rel.slice(0, rel.length - name.length);
          return (
            <li key={rel} className="git-sheet-file">
              <FileIcon name={name} size={13} />
              <span className="git-sheet-file-name">{name}</span>
              {dir && <span className="git-sheet-file-dir mono">{dir}</span>}
              <span className="grow" />
              {by && <span className="git-sheet-by" style={idStyle(by.color)} data-tip={by.title}>{initialOf(by.title)}</span>}
            </li>
          );
        })}
        {files.length > FILES_SHOWN && <li className="git-sheet-more">{s.andMore(files.length - FILES_SHOWN)}</li>}
      </ul>
      <div className="git-sheet-actions">
        <button type="button" className="btn-primary" onClick={() => { closeGitSheet(); void runPull(root, { rebase, sync }); }}>{s.pullAnyway}</button>
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{s.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">esc</span>
      </div>
    </SheetFrame>
  );
}
