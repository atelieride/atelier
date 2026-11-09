import { useLayoutEffect, useRef } from 'react';
import { t } from '../i18n/en';

/**
 * A rename field (sidebar row, tab, session bar): focused with the whole name selected, so typing replaces it. Enter or
 * leaving the field commits, Escape cancels. Keys and clicks stay inside it (the row, the tab and
 * the window shortcuts never see them).
 */
export function RenameInput({ value, className = '', onCommit, onCancel }: { value: string; className?: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const el = useRef<HTMLInputElement>(null);
  // Escape must not commit on the blur that follows when the field goes away.
  const done = useRef(false);
  useLayoutEffect(() => { el.current?.focus(); el.current?.select(); }, []);
  const finish = (fn: () => void) => { if (done.current) return; done.current = true; fn(); };
  return (
    <input ref={el} className={`rename-input ${className}`.trim()} defaultValue={value} aria-label={t.rename} spellCheck={false}
      onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; finish(() => onCommit(v)); }
        if (e.key === 'Escape') { e.preventDefault(); finish(onCancel); }
      }}
      onBlur={(e) => { const v = e.currentTarget.value; finish(() => onCommit(v)); }} />
  );
}
