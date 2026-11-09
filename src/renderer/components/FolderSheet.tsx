import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { folderChoices, relativeCwd, type FolderChoice } from '../folders';
import { newSessionIn, newTerminalIn } from '../launch';
import { stepActive } from '../palette-query';
import { t } from '../i18n/en';
import { useApp, type FolderSheet as Sheet } from '../store';
import { Icon } from './Icon';

/**
 * "New Session/Terminal in Folder…": the top sheet with the project's folders (root first, then repos, then the
 * others). Enter picks; for a session Tab or Enter moves on to the optional name, Enter starts. Esc or a click outside
 * closes. With a folder already chosen (file tree "New Session Here") only the name is asked.
 */
export function FolderSheet({ sheet }: { sheet: Sheet }) {
  const close = () => useApp.getState().setFolderSheet(null);
  const project = useApp((s) => s.project);
  const repos = useApp((s) => s.repos);
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const preset = sheet.cwd ? { path: sheet.cwd, label: relativeCwd(sheet.cwd, project?.root, project?.realRoot) ?? project?.name ?? sheet.cwd } : null;
  const [picked, setPicked] = useState<{ path: string; label: string; root?: boolean } | null>(preset);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const session = sheet.kind === 'session';

  useEffect(() => { void window.atelier.files.index().then(setFiles).catch(() => {}); }, []);
  useEffect(() => { input.current?.focus(); }, [picked === null]);

  const choices = useMemo(() => project
    ? folderChoices({ files, repos: repos.map((r) => ({ root: r.root, branch: r.branch })), root: project.root, realRoot: project.realRoot, name: project.name })
    : [], [files, repos, project]);
  // The root is searched as "./" (its hint): the project name would match half of any query.
  const shown = useMemo(() => fuzzyFilter(choices, query, (c) => (c.rel ? `${c.rel}/` : './'), 300), [choices, query]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector('.folder-item.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  // The root starts exactly like New Session / New Terminal (no cwd); any other folder is checked by the main process.
  const cwdOf = (p: { path: string; root?: boolean }) => (p.root ? undefined : p.path);
  const pick = (c: FolderChoice | undefined) => {
    if (!c) return;
    const p = { path: c.path, label: c.label, root: c.rel === '' };
    if (session) { setPicked(p); return; }
    close();
    void newTerminalIn(cwdOf(p));
  };
  const startSession = (name: string) => {
    if (!picked) return;
    close();
    void newSessionIn(name, cwdOf(picked));
  };

  const title = t.folderSheet[sheet.kind];
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette new-session folder-sheet" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        {/* Keyed: the name field must never reuse the folder field's input (and its text). */}
        {picked ? (
          <div key="name" className="palette-search">
            <span className="new-session-icon"><Icon name="sparkle" size={15} /></span>
            <button type="button" className="folder-chip mono" aria-label={t.folderBack} data-tip={t.folderBack} onClick={() => setPicked(null)}>{picked.label}</button>
            <input ref={input} className="palette-input" placeholder={t.sessionNamePlaceholder} maxLength={200}
              onKeyDown={(e) => {
                if (e.key === 'Enter') startSession(e.currentTarget.value);
                else if (e.key === 'Escape') close();
                else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); setPicked(null); }
              }} />
            <span className="popover-hint mono">↵ {t.start} · esc</span>
          </div>
        ) : (
          <>
            <div key="folder" className="palette-search">
              <span className={session ? 'new-session-icon' : 'folder-sheet-icon'}><Icon name={session ? 'sparkle' : 'terminal'} size={15} /></span>
              <span className="palette-mode">{title}</span>
              <input ref={input} className="palette-input" placeholder={t.folderPlaceholder} value={query} spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') close();
                  else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, shown.length)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, shown.length)); }
                  else if (e.key === 'Enter') pick(shown[active]);
                  else if (e.key === 'Tab') { e.preventDefault(); if (session && !e.shiftKey) pick(shown[active]); }
                }} />
              <span className="popover-hint mono">↵ {session ? t.folderNext : t.folderOpen} · esc</span>
            </div>
            <div className="palette-list" ref={list} role="listbox" aria-label={title}>
              {shown.map((c, i) => (
                <button key={c.path} type="button" role="option" aria-selected={i === active} className={`palette-item folder-item ${i === active ? 'is-active' : ''}`}
                  // Only a real movement selects: a sheet opening under a still pointer keeps the root selected.
                  onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => pick(c)}>
                  <span className={`palette-cmd ${c.repo ? 'is-repo' : ''}`}><Icon name={c.rel === '' ? 'folderOpen' : c.repo ? 'git' : 'files'} size={11} stroke={2} /></span>
                  <span className={`palette-label folder-label ${c.rel ? 'mono' : ''}`}>{c.label}</span>
                  <span className="palette-hint folder-hint mono">{c.hint}</span>
                </button>
              ))}
              {shown.length === 0 && <p className="empty">{t.folderEmpty}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
