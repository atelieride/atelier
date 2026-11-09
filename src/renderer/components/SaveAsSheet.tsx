import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { folderChoices } from '../folders';
import { stepActive } from '../palette-query';
import { caretBeforeSuffix, completeFolder, folderQuery, missingName, outsideName, suggestedSuffix } from '../untitled';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

/**
 * "Save as" for an untitled tab: the top sheet (same look as the palette) with a path relative to the project root.
 * The folders below follow what is typed before the last slash; Tab completes the highlighted one, Enter saves,
 * Esc or a click outside cancels. The main process refuses what it must (outside, .git, existing file) and the
 * reason shows in the sheet. Pinned under the folders, Save Outside the Project…: the
 * list's last option for the keyboard; Enter, Tab or a click on it opens the system's save panel.
 */
export function SaveAsSheet({ path }: { path: string }) {
  const project = useApp((s) => s.project);
  const repos = useApp((s) => s.repos);
  const untitled = useApp((s) => s.openFiles.find((f) => f.path === path)?.rel ?? '');
  const [files, setFiles] = useState<{ path: string; rel: string }[]>([]);
  // A language picked for the tab: its extension is prefilled with the caret before it (a suggestion, deletable).
  const [suffix] = useState(() => suggestedSuffix(useApp.getState().langOverrides[path] ?? null));
  const [value, setValue] = useState(suffix);
  const caret = useRef<number | null>(0);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cancel = () => useApp.getState().cancelSaveAs();

  useEffect(() => { input.current?.focus(); void window.atelier.files.index().then(setFiles).catch(() => {}); }, []);
  // The caret after a programmatic change (open, Tab): before the suggested extension while it is there.
  useEffect(() => {
    const at = caret.current;
    if (at === null || !input.current) return;
    caret.current = null;
    input.current.setSelectionRange(at, at);
  }, [value]);
  const choices = useMemo(() => project
    ? folderChoices({ files, repos: repos.map((r) => ({ root: r.root, branch: r.branch })), root: project.root, realRoot: project.realRoot, name: project.name })
    : [], [files, repos, project]);
  const query = folderQuery(value, suffix);
  const shown = useMemo(() => fuzzyFilter(choices, query, (c) => (c.rel ? `${c.rel}/` : './'), 200), [choices, query]);
  // The pinned Save Outside the Project… row highlighted (it stands after the last folder for ↑/↓).
  const [outside, setOutside] = useState(false);
  useEffect(() => { setActive(0); setOutside(false); }, [query]);
  useEffect(() => { list.current?.querySelector('.folder-item.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const step = (delta: 1 | -1) => {
    // No folder shown: the arrows go on and off the pinned row (Enter saves the typed name again once off it).
    if (shown.length === 0) { setOutside((on) => !on); return; }
    const next = stepActive(outside ? shown.length : active, delta, shown.length + 1);
    setOutside(next === shown.length);
    if (next < shown.length) setActive(next);
  };

  const complete = (rel: string) => {
    const next = completeFolder(value, rel, suffix);
    caret.current = caretBeforeSuffix(next, suffix);
    setValue(next);
    setError(null);
    input.current?.focus();
  };
  const save = async () => {
    const rel = value.trim().replace(/^(\.\/)+/, '');
    if (missingName(rel, suffix)) { setError(t.saveAsNeedsName); return; }
    if (busy) return;
    setBusy(true);
    const r = await useApp.getState().submitSaveAs(rel).catch(() => ({ error: 'failed' }));
    setBusy(false);
    if ('error' in r) setError(t.saveAsErrors[r.error] ?? t.saveFailed(r.error));
  };
  // The system's save panel, its name field holding the name typed (else the tab's); canceled: back to the field.
  const saveOutside = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await useApp.getState().submitSaveAsOutside(outsideName(value, suffix, untitled)).catch(() => ({ error: 'failed' }));
    setBusy(false);
    if ('error' in r) setError(t.saveAsErrors[r.error] ?? t.saveFailed(r.error));
    else if ('canceled' in r) input.current?.focus();
  };

  return (
    <div className="palette-backdrop" onMouseDown={cancel}>
      <div className="palette folder-sheet save-as-sheet" role="dialog" aria-label={t.saveAsTitle(untitled)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="folder-sheet-icon"><FileIcon name={value.split('/').at(-1) || 'x'} size={15} /></span>
          <span className="palette-mode">{t.saveAs}</span>
          <input ref={input} className="palette-input mono" placeholder={t.saveAsPlaceholder} value={value} spellCheck={false} aria-label={t.saveAsTitle(untitled)}
            aria-invalid={error !== null} onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
              else if (e.key === 'Enter') void (outside ? saveOutside() : save());
              else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
              else if (e.key === 'Tab') { e.preventDefault(); const c = shown[active]; if (outside) void saveOutside(); else if (c) complete(c.rel); }
            }} />
          <span className="popover-hint mono">{outside ? <>↵ {t.saveAsChoose} · esc</> : <>↵ {t.save} · ⇥ {t.saveAsFolder} · esc</>}</span>
        </div>
        {error && <div className="save-as-error" role="alert"><Icon name="info" size={13} />{error}</div>}
        <div className="palette-section">{t.saveAsFolders}</div>
        <div className="palette-list" ref={list} role="listbox" aria-label={t.saveAsFolders}>
          {shown.map((c, i) => (
            <button key={c.path} type="button" role="option" aria-selected={!outside && i === active} className={`palette-item folder-item ${!outside && i === active ? 'is-active' : ''}`}
              onMouseMove={() => { if (outside || i !== active) { setOutside(false); setActive(i); } }} onClick={() => complete(c.rel)}>
              <span className={`palette-cmd ${c.repo ? 'is-repo' : ''}`}><Icon name={c.rel === '' ? 'folderOpen' : c.repo ? 'git' : 'files'} size={11} stroke={2} /></span>
              <span className={`palette-label folder-label ${c.rel ? 'mono' : ''}`}>{c.label}</span>
              <span className="palette-hint folder-hint mono">{c.hint}</span>
            </button>
          ))}
          {/* No slash typed and no folder matching: it is just a file name, saved at the root. */}
          {shown.length === 0 && <p className="empty">{value.includes('/') ? t.folderEmpty : t.saveAsAtRoot}</p>}
        </div>
        {/* Pinned: never scrolls away with the folders. The field keeps the focus (typing goes on). */}
        <div className="save-as-out" role="listbox" aria-label={t.saveAsOutside}>
          <button type="button" role="option" aria-selected={outside} className={`palette-item save-as-outside ${outside ? 'is-active' : ''}`} disabled={busy}
            onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (!outside) setOutside(true); }} onClick={() => void saveOutside()}>
            <span className="palette-cmd"><Icon name="externalLink" size={11} stroke={2} /></span>
            <span className="palette-label">{t.saveAsOutside}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
