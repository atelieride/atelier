import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cmTheme } from './cmTheme';
import { diffExtensions } from './decorations';
import { unifiedDoc } from './linediff';
import { t } from '../i18n/en';

/** Conflict: what is on disk (−) and what is in the editor (+), read-only above the editor (which stays as it is). */
export function ConflictCompare({ disk, buffer, onClose }: { disk: string; buffer: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const d = unifiedDoc(disk, buffer);
    const v = new EditorView({
      state: EditorState.create({ doc: d ? d.text : buffer, extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false), ...(d ? diffExtensions(d) : []), cmTheme] }),
      parent: host.current
    });
    return () => v.destroy();
  }, [disk, buffer]);
  return (
    <div className="compare-layer" role="dialog" aria-label={t.compareTitle} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="compare-head">
        <span className="compare-title">{t.compareTitle}</span>
        <span className="compare-legend"><i className="minus" />{t.onDisk}<i className="plus" />{t.inEditor}</span>
        <span className="grow" />
        <button type="button" className="btn-ghost sm" onClick={onClose} autoFocus>{t.close}</button>
      </div>
      <div ref={host} className="compare-body" />
    </div>
  );
}
