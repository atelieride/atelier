// The files a search could not read, from the summary's "· 2 files not searched": each with its reason and size, and
// Reveal in Files. Binary files never show here: they cannot hold a text match worth showing.
import { useEffect, useRef } from 'react';
import { SEARCH_LIMITS, type SkippedFile } from '@shared/search';
import { FileIcon } from '../components/FileIcon';
import { Icon } from '../components/Icon';
import { useApp } from '../store';
import { ts } from './copy';
import { fileSize } from './model';

const reasonOf = (f: SkippedFile): string => (f.reason === 'too-large' ? ts.tooLarge(fileSize(SEARCH_LIMITS.maxBytes)) : ts.unreadable);

/** `onClose(back)`: `back` when the keyboard closed it (Esc, its ×) and should go back to what opened it. */
export function SkippedPopover({ files, onClose }: { files: SkippedFile[]; onClose: (back: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    // A press elsewhere closes it and keeps the focus it gives (the link that opened it toggles it itself).
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && (box.current?.contains(e.target) || e.target.closest('.fif-skipped-link'))) return;
      close.current(false);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  return (
    <div ref={box} className="fif-skipped" role="dialog" aria-label={ts.skippedTitle(files.length)} tabIndex={-1} data-own-esc=""
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); } }}>
      <div className="fif-skipped-head">
        <span className="section-label">{ts.skippedTitle(files.length)}</span>
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label={ts.close} data-tip={ts.close} onClick={() => onClose(true)}><Icon name="x" size={12} stroke={1.8} /></button>
      </div>
      <ul className="fif-skipped-list">
        {files.map((f) => (
          <li key={f.path} className="fif-skipped-row">
            <FileIcon name={f.rel.slice(f.rel.lastIndexOf('/') + 1)} />
            <span className="fif-skipped-text">
              <span className="fif-skipped-rel mono" title={f.rel}>{f.rel}</span>
              <span className="fif-skipped-why">{reasonOf(f)}{f.size > 0 && <> <span className="fif-skipped-size mono">· {fileSize(f.size)}</span></>}</span>
            </span>
            <button type="button" className="icon-btn" aria-label={`${ts.revealInFiles}: ${f.rel}`} data-tip={ts.revealInFiles}
              onClick={() => { onClose(false); useApp.getState().revealInTree(f.path); }}><Icon name="files" size={13} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
