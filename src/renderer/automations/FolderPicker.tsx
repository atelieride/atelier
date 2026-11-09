// The editor's Folder: a button with the folder, opening a searchable popover of
// the project's folders (the "in Folder…" sheet's choices). ↑↓ move, Enter picks, Esc or Tab closes it only. Another
// project's automation (this window can't list its folders) picks the root or a typed path.
import { useEffect, useMemo, useRef, useState } from 'react';
import { folderChoices, truncateLeft, type FolderChoice } from '../folders';
import { stepActive } from '../palette-query';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from '../components/Icon';
import { ChoicePopover } from './ChoicePopover';
import { folderLabel, folderRows } from './folder-pick';

const te = t.auto.editor;

export function FolderPicker({ value, projectRoot, onChange }: { value: string; projectRoot: string; onChange: (rel: string) => void }) {
  const win = useApp((s) => s.project);
  const repos = useApp((s) => s.repos);
  const local = !!win && (win.root === projectRoot || win.realRoot === projectRoot);
  const name = local ? win.name : projectRoot.replace(/\/+$/, '').split('/').pop() || projectRoot;
  const [files, setFiles] = useState<{ rel: string }[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Picked in this editor: the user chose it, never warned about.
  const [picked, setPicked] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!local) return;
    let gone = false;
    void window.atelier.files.index().then((f) => { if (!gone) setFiles(f); }).catch(() => { if (!gone) setFiles([]); });
    return () => { gone = true; };
  }, [local]);

  const choices = useMemo<FolderChoice[]>(() => (local && win
    ? folderChoices({ files: files ?? [], repos: repos.map((r) => ({ root: r.root, branch: r.branch })), root: win.root, realRoot: win.realRoot, name: win.name })
    : [{ path: projectRoot, rel: '', label: name, hint: './', repo: false }]), [local, win, files, repos, projectRoot, name]);
  const { rows, typed } = useMemo(() => folderRows(choices, query), [choices, query]);
  const count = rows.length + (typed ? 1 : 0);
  // Read and not there: deleted since, or only ignored files in it.
  const gone = local && !picked && files !== null && value !== '' && !choices.some((c) => c.rel === value);

  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const show = () => {
    setQuery('');
    setActive(Math.max(0, folderRows(choices, '').rows.findIndex((c) => c.rel === value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); };
  const pick = (rel: string) => { onChange(rel); setPicked(true); close(true); };
  const pickAt = (i: number) => { if (i < rows.length) pick(rows[i]!.rel); else if (typed) pick(typed); };

  return (
    <>
      <button ref={button} type="button" className={`ae-folder ${open ? 'is-open' : ''} ${gone ? 'is-gone' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${te.folder}: ${folderLabel(name, value)}`} data-tip={gone ? te.folderGone : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); show(); } }}>
        <Icon name={value ? 'files' : 'folderOpen'} size={12} />
        <span className="ae-folder-path mono">{truncateLeft(folderLabel(name, value), 64)}</span>
        {gone && <Icon name="warning" size={12} />}
        <Icon name="chevronDown" size={11} />
      </button>
      {gone && <span className="ae-hint is-warn">{te.folderGone}</span>}
      {open && button.current && (
        <ChoicePopover anchor={button.current} minWidth={360} onClose={() => close(false)}>
          <div className="ae-pop-search">
            <Icon name="search" size={12} />
            <input autoFocus className="ae-pop-input" value={query} placeholder={te.searchFolders} spellCheck={false} aria-label={te.searchFolders}
              role="combobox" aria-expanded="true" aria-controls="ae-folder-list" aria-activedescendant={count ? `ae-folder-${active}` : undefined}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
                // Tab moves on from the button (the popover sits at the end of the page).
                else if (e.key === 'Tab') close(true);
                else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, count)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, count)); }
                else if (e.key === 'Enter') { e.preventDefault(); pickAt(active); }
              }} />
          </div>
          <div ref={list} id="ae-folder-list" className="ae-pop-list" role="listbox" aria-label={te.chooseFolder}>
            {rows.map((c, i) => (
              <button key={c.path} id={`ae-folder-${i}`} type="button" role="option" aria-selected={c.rel === value} tabIndex={-1}
                className={`ae-pop-row ${i === active ? 'is-active' : ''} ${c.rel === value ? 'is-chosen' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => pick(c.rel)}>
                <span className={`ae-pop-ic ${c.repo ? 'is-repo' : ''}`}><Icon name={c.rel === '' ? 'folderOpen' : c.repo ? 'git' : 'files'} size={11} stroke={2} /></span>
                <span className={`ae-pop-label ${c.rel ? 'mono' : ''}`}>{c.label}</span>
                <span className="ae-pop-hint mono">{c.hint}</span>
                {c.rel === value && <Icon name="check" size={11} stroke={2.4} />}
              </button>
            ))}
            {typed && (
              <button id={`ae-folder-${rows.length}`} type="button" role="option" aria-selected={false} tabIndex={-1}
                className={`ae-pop-row is-add ${active === rows.length ? 'is-active' : ''}`}
                onMouseMove={() => { if (active !== rows.length) setActive(rows.length); }} onClick={() => pick(typed)}>
                <span className="ae-pop-ic"><Icon name="plus" size={11} stroke={2} /></span>
                <span className="ae-pop-label mono">{te.useFolder(typed)}</span>
              </button>
            )}
            {local && files === null && <p className="ae-pop-empty">{te.foldersLoading}</p>}
            {count === 0 && <p className="ae-pop-empty">{te.noFolder}</p>}
          </div>
        </ChoicePopover>
      )}
    </>
  );
}
