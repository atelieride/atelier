// Unsaved files when closing tabs: one file closing from its tab asks under that tab; several,
// or a rename or trash of what holds them, ask in a sheet with a box per file. The sheet serves the window's own close
// too (UnsavedSheet).
import { useLayoutEffect, useRef, useState } from 'react';
import { useApp, tabName } from '../store';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { SheetFrame } from '../git/SheetFrame';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { ConfirmPopover } from './ConfirmPopover';
import type { UnsavedAnswer } from './slice';

/** ⌘S from the app menu while the question is open: the question's Save (with its boxes), not the active tab's. */
let saveNow: (() => void) | null = null;
export function saveFromKeys(): void { saveNow?.(); }

export interface UnsavedFile { path: string; name: string; dir: string }

/** The files as the sheet lists them: the tab's name, and the folder it is in (the project's relative one). */
export function unsavedFiles(paths: string[], files: { path: string; rel: string }[]): UnsavedFile[] {
  return paths.map((path) => {
    const rel = files.find((f) => f.path === path)?.rel ?? path;
    const name = tabName(files as Parameters<typeof tabName>[0], path);
    const cut = rel.lastIndexOf('/');
    return { path, name, dir: rel.startsWith('untitled:') || cut < 0 ? '' : rel.slice(0, cut) };
  });
}

/** The primary's words: Save, Save All or Save ‹n›, then what follows ("& Close"…). */
export function savePrimary(checked: number, total: number, then: string | null): string {
  const verb = total === 1 || checked === 0 ? t.confirm.save : checked === total ? t.confirm.saveAll : t.confirm.saveN(checked);
  return then ? `${verb} & ${then}` : verb;
}

export function UnsavedHost() {
  const q = useApp((s) => s.unsavedAsk);
  const files = useApp((s) => s.openFiles);
  // From its tab: under the tab when the tab is on screen, else the sheet.
  const [tabShown, setTabShown] = useState(false);
  useLayoutEffect(() => {
    const el = q?.tab ? document.querySelector(`.tab[data-key="${CSS.escape(q.tab)}"]`) : null;
    setTabShown(el instanceof HTMLElement && el.offsetParent !== null);
  }, [q]);
  if (!q) return null;
  const list = unsavedFiles(q.paths, files);
  const answer = (a: UnsavedAnswer) => useApp.getState().answerUnsaved(a);
  if (q.tab && tabShown && list.length === 1) return <UnsavedPopover key={q.tab} tab={q.tab} file={list[0]!} onAnswer={answer} />;
  return (
    <UnsavedSheet key={q.paths.join('\n')} files={list} title={list.length === 1 ? t.confirm.saveTitle(list[0]!.name) : t.confirm.unsavedMany(list.length)}
      note={t.confirm.lostMany} then={q.how === 'close' ? t.confirm.thenClose : null} onAnswer={answer} />
  );
}

function UnsavedPopover({ tab, file, onAnswer }: { tab: string; file: UnsavedFile; onAnswer: (a: UnsavedAnswer) => void }) {
  const save = () => onAnswer({ save: [file.path] });
  const discard = () => onAnswer('discard');
  const latest = useRef(save);
  latest.current = save;
  useLayoutEffect(() => {
    const fn = () => latest.current();
    saveNow = fn;
    return () => { if (saveNow === fn) saveNow = null; };
  }, []);
  const title = t.confirm.saveTitle(file.name);
  return (
    <ConfirmPopover anchor={`.tab[data-key="${CSS.escape(tab)}"]`} align="start" label={title} onCancel={() => onAnswer('cancel')}>
      <div className="confirm-pop-text">
        <b>{title}</b>
        <span className="confirm-note">{t.confirm.lost}</span>
      </div>
      <div className="confirm-actions is-end"
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
          else if (mod && e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); discard(); }
        }}>
        <button type="button" className="btn-text-danger" onClick={discard}>{t.confirm.dontSave}<span className="confirm-key mono">{kbd('⌘⌫')}</span></button>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={() => onAnswer('cancel')}>{t.confirm.cancel}</button>
        <button type="button" className="btn-primary" data-autofocus onClick={save}>{t.confirm.save}<span className="confirm-key mono is-on-brand">{kbd('⌘S')}</span></button>
      </div>
    </ConfirmPopover>
  );
}

/**
 * The unsaved files, a box each (all checked; with one file no box): Don't Save, Cancel, and the primary that saves the
 * checked ones (the others are discarded). `then`: what happens after ("Close", "Quit"…), in the primary's words.
 */
export function UnsavedSheet({ files, title, note, then, onAnswer, listOne = false }: { files: UnsavedFile[]; title: string; note: string; then: string | null; onAnswer: (a: UnsavedAnswer) => void; listOne?: boolean }) {
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const keep = files.filter((f) => !unchecked.includes(f.path)).map((f) => f.path);
  const save = () => { if (keep.length) onAnswer({ save: keep }); };
  const latest = useRef(save);
  latest.current = save;
  useLayoutEffect(() => {
    const fn = () => latest.current();
    saveNow = fn;
    return () => { if (saveNow === fn) saveNow = null; };
  }, []);
  return (
    <SheetFrame title={title} icon="edit" tone="warn" className="confirm-sheet" onClose={() => onAnswer('cancel')}>
      <p className="git-sheet-body">{note}</p>
      {(files.length > 1 || listOne) && (
        <ul className="git-sheet-files">
          {files.map((f) => {
            const on = !unchecked.includes(f.path);
            return (
              <li key={f.path} className="git-sheet-file">
                <label className="git-sheet-check confirm-file">
                  {/* One file: named, nothing to choose. */}
                  {files.length > 1 && <input type="checkbox" checked={on} onChange={() => setUnchecked((u) => (on ? [...u, f.path] : u.filter((p) => p !== f.path)))} />}
                  <FileIcon name={f.name} size={13} />
                  <span className="git-sheet-file-name">{f.name}</span>
                  {f.dir && <span className="git-sheet-file-dir mono">{f.dir}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="git-sheet-actions">
        <button type="button" className="btn-text-danger" onClick={() => onAnswer('discard')}>{t.confirm.dontSave}</button>
        <span className="grow" />
        <button type="button" className="btn-ghost" onClick={() => onAnswer('cancel')}>{t.confirm.cancel}</button>
        <button type="button" className="btn-primary" data-autofocus disabled={keep.length === 0} onClick={save}>
          <Icon name="check" size={13} stroke={2} />{savePrimary(keep.length, files.length, then)}
        </button>
      </div>
    </SheetFrame>
  );
}
