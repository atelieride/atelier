import { useEffect, useRef } from 'react';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { FontList, useFontBrowse } from './FontList';
import { Icon } from './Icon';

/**
 * Change Terminal Font…: the palette's top sheet listing the fonts, the one in use
 * selected. Moving the selection shows that font on every terminal of the window; Enter keeps it, Esc or a click
 * outside goes back. The backdrop doesn't blur: the terminals behind it are the preview.
 */
export function FontSheet() {
  const input = useRef<HTMLInputElement>(null);
  const b = useFontBrowse(() => useApp.getState().setFontSheet(false));
  useEffect(() => { input.current?.focus(); }, []);
  const active = b.index >= 0 ? `font-sheet-${b.index}` : undefined;
  return (
    <div className="palette-backdrop is-clear" onMouseDown={b.back}>
      <div className="palette font-sheet" role="dialog" aria-label={t.fontPick.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="folder-sheet-icon"><Icon name="terminal" size={15} /></span>
          <span className="palette-mode">{t.fontPick.mode}</span>
          <input ref={input} className="palette-input" placeholder={t.fontPick.search} value={b.query} spellCheck={false} aria-label={t.fontPick.title}
            role="combobox" aria-expanded="true" aria-controls="font-sheet-list" aria-activedescendant={active}
            onChange={(e) => b.search(e.target.value)} onKeyDown={b.onKey} />
          <span className="popover-hint mono">{t.fontPick.keys}</span>
        </div>
        <FontList b={b} idPrefix="font-sheet" variant="sheet" />
      </div>
    </div>
  );
}
