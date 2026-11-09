// Discard: "Discard changes to welcome.tsx?" / "…to 4 files?", the Trash line, the files
// with who wrote their lines, the session editing them now (sky), then Discard (rose) and Cancel. Cancel takes the
// focus, so Enter never discards: only a click on Discard or ⌘↵ does. No Undo afterwards: the Trash is the undo.
import { useEffect, useMemo, useRef } from 'react';
import { idStyle, initialOf } from '../avatar';
import { FileIcon } from '../components/FileIcon';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { discardTargets } from './actions';
import { discardPlan, discardTitle, liveNotice, type DiscardTarget } from './discard';
import { liveFiles } from './live';
import { SheetFrame, closeGitSheet } from './SheetFrame';
import { isMod } from '@shared/keys';

const FILES_SHOWN = 5;
const BY_SHOWN = 3;

export function DiscardSheet({ targets }: { targets: DiscardTarget[] }) {
  const d = t.git.discard;
  const repos = useApp((x) => x.repos);
  const terminals = useApp((x) => x.terminals);
  const attributions = useApp((x) => x.attributions);
  const plan = useMemo(() => discardPlan(targets, repos, attributions, liveFiles(terminals, attributions)), [targets, repos, terminals, attributions]);
  const live = liveNotice(plan);
  const several = new Set(targets.map((x) => x.root)).size > 1;
  const nameOf = (root: string) => repos.find((r) => r.root === root)?.name ?? root.split('/').pop() ?? root;

  const go = useRef(() => {});
  go.current = () => { closeGitSheet(); void discardTargets(targets); };
  // ⌘↵ discards from anywhere in the sheet (Enter alone presses the focused button: Cancel by default).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !isMod(e) || e.repeat) return;
      e.preventDefault(); e.stopPropagation();
      go.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const shown = plan.files.slice(0, FILES_SHOWN);
  return (
    <SheetFrame title={discardTitle(plan)} icon="trash" tone="danger">
      <p className="git-sheet-body">{d.trash(plan.count)}</p>
      {live && (
        <div className="git-notice is-live">
          <i className="git-notice-dot id-dot" style={idStyle(live.color)} />
          <span className="git-notice-text" data-tip={live.text}>{live.text}</span>
        </div>
      )}
      {shown.length > 0 && (
        <ul className="git-sheet-files">
          {shown.map((f) => {
            const name = f.rel.split('/').pop() ?? f.rel;
            const dir = f.rel.slice(0, f.rel.length - name.length);
            const where = f.origRel ? d.renamed(f.origRel) : `${several ? `${nameOf(f.root)} › ` : ''}${dir}`;
            return (
              <li key={`${f.root}\n${f.rel}`} className="git-sheet-file">
                <FileIcon name={name} size={13} />
                <span className="git-sheet-file-name">{name}</span>
                {where && <span className="git-sheet-file-dir mono">{where}</span>}
                <span className="grow" />
                {f.by.slice(0, BY_SHOWN).map((b) => (
                  <span key={b.terminalId} className="git-sheet-by" style={idStyle(b.color)} data-tip={d.wrote(b.title)} aria-label={d.wrote(b.title)}>{initialOf(b.title)}</span>
                ))}
              </li>
            );
          })}
          {plan.files.length > FILES_SHOWN && <li className="git-sheet-more">{t.git.sync.andMore(plan.files.length - FILES_SHOWN)}</li>}
          {plan.notListed > 0 && <li className="git-sheet-more">{t.git.notListed(plan.notListed)}</li>}
        </ul>
      )}
      <div className="git-sheet-actions">
        <button type="button" className="btn-danger" onClick={() => go.current()}>{d.go}</button>
        {/* The safe answer takes the focus: Enter never discards by accident. */}
        <button type="button" className="btn-ghost" data-autofocus onClick={closeGitSheet}>{t.git.sync.cancel}</button>
        <span className="grow" />
        <span className="popover-hint mono">{d.keys}</span>
      </div>
    </SheetFrame>
  );
}
