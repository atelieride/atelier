import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { folderChoices, type FolderChoice } from '../folders';
import { newSessionIn, newTerminalIn } from '../launch';
import { stepActive } from '../palette-query';
import { radioNext } from '../radio';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { useApp } from '../store';
import { MAX_NAME, nextColor, WS_COLORS } from '../workspaces';
import { wsColorVar } from '../workspace-view';
import { Icon } from './Icon';
import { WorkspaceGlyph } from './WorkspaceGlyph';
import { Segmented } from './Segmented';

type Start = 'session' | 'terminal' | 'empty';

/**
 * New Workspace (⌥⌘T): name, color, what it starts with, its folder (an existing one in the
 * project, the root by default), a task for its first session. Enter creates it, brings it forward and starts it.
 */
export function NewWorkspaceSheet() {
  const sheet = useApp((s) => s.wsSheet);
  const ws = useApp((s) => s.ws);
  const project = useApp((s) => s.project);
  const repos = useApp((s) => s.repos);
  const hasTasks = useApp((s) => s.connectors.some((c) => c.status === 'connected'));
  const close = () => useApp.getState().setWsSheet(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => (ws ? nextColor(ws.list) : 1));
  const [start, setStart] = useState<Start>('session');
  const [folder, setFolder] = useState<FolderChoice | null>(null);
  const [picking, setPicking] = useState(false);
  const [task, setTask] = useState(false);
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const nameEl = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLDivElement>(null);

  useEffect(() => { nameEl.current?.focus(); }, []);
  useEffect(() => { if (picking && !files.length) void window.atelier.files.index().then(setFiles).catch(() => {}); }, [picking]);
  const choices = useMemo(() => project
    ? folderChoices({ files, repos: repos.map((r) => ({ root: r.root, branch: r.branch })), root: project.root, realRoot: project.realRoot, name: project.name })
    : [], [files, repos, project]);
  const shown = useMemo(() => fuzzyFilter(choices, query, (c) => (c.rel ? `${c.rel}/` : './'), 200), [choices, query]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { listEl.current?.querySelector('.folder-item.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  if (!sheet || !ws) return null;
  const full = ws.list.length >= 20;
  const ready = name.trim().length > 0 && !full;
  const create = () => {
    if (!ready) return;
    const st = useApp.getState();
    const id = st.newWorkspace({ name, color, folder: folder && folder.rel !== '' ? folder.path : null }, sheet.move);
    close();
    if (!id) return;
    // It is in front now: what starts lands in it (and in its folder).
    if (start === 'session') {
      if (task) st.setPaletteOpen(true, 'task:');
      else void newSessionIn('');
    } else if (start === 'terminal') void newTerminalIn();
  };
  const pickFolder = (c: FolderChoice | undefined) => { if (!c) return; setFolder(c); setPicking(false); setQuery(''); nameEl.current?.focus(); };
  const colors = Array.from({ length: WS_COLORS }, (_, i) => i + 1);

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette nws" role="dialog" aria-label={t.ws.sheetTitle} onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (picking) { setPicking(false); nameEl.current?.focus(); } else close(); } }}>
        <div className="nws-head">
          <WorkspaceGlyph color={color} size={18} />
          <span className="nws-title">{t.ws.sheetTitle}</span>
          <span className="grow" />
          <span className="popover-hint mono">{kbd('⌘⌥T')}</span>
        </div>
        <div className="nws-body">
          <label className="nws-row">
            <span className="nws-label">{t.ws.name}</span>
            <input ref={nameEl} className="nws-input" value={name} maxLength={MAX_NAME} placeholder={t.ws.namePlaceholder} spellCheck={false}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
          </label>
          <div className="nws-row">
            <span className="nws-label" id="nws-color">{t.ws.color}</span>
            <div className="nws-swatches" role="radiogroup" aria-labelledby="nws-color"
              onKeyDown={(e) => { const n = radioNext(colors, color, e.key); if (n !== null) { e.preventDefault(); setColor(n); (e.currentTarget.children[n - 1] as HTMLElement | undefined)?.focus(); } }}>
              {colors.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={t.ws.colors[c - 1]} data-tip={t.ws.colors[c - 1]} tabIndex={c === color ? 0 : -1}
                  className={`nws-swatch ${c === color ? 'is-on' : ''}`} style={{ '--sw': wsColorVar(c) } as React.CSSProperties} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
          <div className="nws-row">
            <span className="nws-label">{t.ws.startWith}</span>
            <Segmented label={t.ws.startWith} value={start} onChange={setStart}
              options={[{ value: 'session', label: t.ws.startSession }, { value: 'terminal', label: t.ws.startTerminal }, { value: 'empty', label: t.ws.startEmpty }]} />
          </div>
          <div className="nws-row">
            <span className="nws-label">{t.ws.folder}</span>
            <span className="nws-folder mono">{folder && folder.rel !== '' ? folder.label : project?.name ?? ''}</span>
            <span className="nws-folder-hint">{folder && folder.rel !== '' ? '' : t.ws.projectRoot}</span>
            <span className="grow" />
            <button type="button" className="btn-ghost sm" aria-expanded={picking} onClick={() => setPicking(!picking)}>{t.ws.change}</button>
          </div>
          {picking && (
            <div className="nws-picker">
              <input className="nws-input" autoFocus placeholder={t.folderPlaceholder} value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, shown.length)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, shown.length)); }
                  else if (e.key === 'Enter') { e.preventDefault(); pickFolder(shown[active]); }
                }} />
              <div className="palette-list nws-folders" ref={listEl} role="listbox" aria-label={t.ws.folder}>
                {shown.map((c, i) => (
                  <button key={c.path} type="button" role="option" aria-selected={i === active} className={`palette-item folder-item ${i === active ? 'is-active' : ''}`}
                    onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => pickFolder(c)}>
                    <span className={`palette-cmd ${c.repo ? 'is-repo' : ''}`}><Icon name={c.rel === '' ? 'folderOpen' : c.repo ? 'git' : 'files'} size={11} stroke={2} /></span>
                    <span className={`palette-label folder-label ${c.rel ? 'mono' : ''}`}>{c.label}</span>
                    <span className="palette-hint folder-hint mono">{c.hint}</span>
                  </button>
                ))}
                {shown.length === 0 && <p className="empty">{t.folderEmpty}</p>}
              </div>
            </div>
          )}
          {start === 'session' && hasTasks && (
            <label className="nws-row nws-check">
              <input type="checkbox" checked={task} onChange={(e) => setTask(e.target.checked)} />
              <span>{t.ws.fromTask}</span>
            </label>
          )}
          <p className="nws-note">{full ? t.ws.full : t.ws.sheetNote}</p>
        </div>
        <div className="nws-foot">
          <button type="button" className="btn-ghost" onClick={close}>{t.confirm.cancel}</button>
          <button type="button" className="btn-primary" disabled={!ready} onClick={create}>
            {start === 'session' ? t.ws.createAndStart : start === 'terminal' ? t.ws.createAndTerminal : t.ws.create}<span className="kbd-in">↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
