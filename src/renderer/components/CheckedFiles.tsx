import { useEffect, useRef, useState } from 'react';
import type { CheckedFile } from '@shared/api';
import { SETTINGS_FIELDS, isSettingPath } from '@shared/settings';
import { t } from '../i18n/en';
import { Icon } from './Icon';

const MAX = (SETTINGS_FIELDS.shellEnvWatchFiles as { max: number }).max;
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

/**
 * Settings › Terminal › Checked files: zsh's startup files (fixed) and the user's
 * extra ones, checked before a new Atelier terminal. Main says which exist; adding goes through the open panel.
 */
export function CheckedFiles({ extra, off }: { extra: string[]; off: boolean }) {
  const [files, setFiles] = useState<CheckedFile[] | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const key = extra.join('\u0000');
  useEffect(() => {
    let live = true;
    const load = () => void window.atelier.shellEnv.files().then((f) => { if (live && f) setFiles(f); }).catch(() => {});
    load();
    // Back from the editor or Finder: a file created or deleted meanwhile shows its new state.
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, [key]);

  const add = async () => {
    const picked = await window.atelier.shellEnv.pickFiles().catch(() => [] as string[]);
    const next = [...new Set([...extra, ...picked.filter(isSettingPath)])].slice(0, MAX);
    if (next.length !== extra.length) void window.atelier.settings.set({ shellEnvWatchFiles: next });
  };
  // The removed row's index among the extra files: once it is gone, focus moves to its neighbour (see below).
  const refocus = useRef<number | null>(null);
  const remove = (p: string) => {
    refocus.current = extra.indexOf(p);
    // Gone at once (main confirms through the settings): the row doesn't wait for the round trip.
    setFiles((f) => f?.filter((x) => x.path !== p) ?? null);
    void window.atelier.settings.set({ shellEnvWatchFiles: extra.filter((x) => x !== p) });
  };
  // The keyboard stays in the list: the next file's remove button, or Add File….
  useEffect(() => {
    const i = refocus.current;
    if (i === null) return;
    refocus.current = null;
    const dels = [...(list.current?.querySelectorAll<HTMLElement>('.chk-del') ?? [])];
    (dels[Math.min(i, dels.length - 1)] ?? list.current?.parentElement?.querySelector<HTMLElement>('.chk-add'))?.focus();
  }, [files]);

  return (
    <section className={`chk-section${off ? ' is-off' : ''}`} aria-label={t.set.checkedFiles}>
      <div className="chk-title">{t.set.checkedFiles}</div>
      <ul className="chk-list" ref={list}>
        {(files ?? []).map((f) => (
          <li key={f.path} className={`chk-file${f.builtin ? ' is-builtin' : ''}${f.exists ? '' : ' is-absent'}`}>
            <Icon name="files" size={14} />
            {/* The name first: a long folder is what gets cut. */}
            <span className="chk-path mono" title={f.path}><span className="chk-name">{base(f.label)}</span><span className="chk-dir">{dir(f.label)}</span></span>
            {f.builtin && <span className="chk-chip">{t.set.checkedFileZsh}</span>}
            {!f.builtin && !f.exists && <span className="chk-chip is-missing">{t.set.checkedFileMissing}</span>}
            {!f.builtin && (
              <button type="button" className="icon-btn chk-del" aria-label={t.set.checkedFileRemove(f.label)} title={t.set.checkedFileRemove(f.label)} onClick={() => remove(f.path)}>
                <Icon name="x" size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn-ghost chk-add" disabled={extra.length >= MAX} title={extra.length >= MAX ? t.set.checkedFilesFull(MAX) : undefined} onClick={() => void add()}><Icon name="plus" size={13} />{t.set.checkedFileAdd}</button>
    </section>
  );
}
