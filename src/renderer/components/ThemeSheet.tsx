import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { THEMES, type ThemeInfo } from '@shared/themes';
import { stepActive } from '../palette-query';
import { keepPreview, previewTheme } from '../settings-live';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';
import { ThemeThumb } from './ThemePicker';

/**
 * Change Theme…: the palette's top sheet listing the themes, the one in use selected. Moving the
 * selection (arrows or the pointer) shows that theme on the whole window and its terminals; Enter keeps it, Esc or a
 * click outside goes back to the one in use.
 */
export function ThemeSheet() {
  const current = useApp((s) => s.settings.theme);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => fuzzyFilter([...THEMES], query.trim(), (th) => th.name, THEMES.length), [query]);
  const [active, setActive] = useState(Math.max(0, THEMES.findIndex((th) => th.id === current)));

  useEffect(() => { input.current?.focus(); }, []);
  // Closed by anything but Enter (another sheet taking its place, the window's state changing): the preview goes.
  const kept = useRef(false);
  useEffect(() => () => { if (!kept.current) previewTheme(null); }, []);
  // Whatever is selected is on screen; leaving without Enter puts the theme in use back.
  const move = (i: number) => {
    setActive(i);
    const th = shown[i];
    if (th) previewTheme(th.id);
  };
  const back = () => { previewTheme(null); useApp.getState().setThemeSheet(false); };
  const keep = (th: ThemeInfo | undefined) => {
    if (!th) return;
    kept.current = true;
    useApp.getState().setThemeSheet(false);
    // The preview stays on screen until main sends the saved settings back.
    if (th.id === current) previewTheme(null);
    else { keepPreview(); void window.atelier.settings.set({ theme: th.id }); }
  };

  return (
    <div className="palette-backdrop" onMouseDown={back}>
      <div className="palette theme-sheet" role="dialog" aria-label={t.themeSheet.title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="folder-sheet-icon"><Icon name="appearance" size={15} /></span>
          <span className="palette-mode">{t.themeSheet.mode}</span>
          <input ref={input} className="palette-input" placeholder={t.themeSheet.placeholder} value={query} spellCheck={false} aria-label={t.themeSheet.title}
            role="combobox" aria-expanded="true" aria-controls="theme-list" aria-activedescendant={shown[active] ? `theme-${shown[active]!.id}` : undefined}
            // The best match is selected, and shown: Enter keeps what is on screen.
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              const first = fuzzyFilter([...THEMES], e.target.value.trim(), (th) => th.name, THEMES.length)[0];
              if (first) previewTheme(first.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); back(); }
              else if (e.key === 'Enter') { e.preventDefault(); keep(shown[active]); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); move(stepActive(active, 1, shown.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(stepActive(active, -1, shown.length)); }
            }} />
          <span className="popover-hint mono">{t.themeSheet.keys}</span>
        </div>
        <div className="palette-list" id="theme-list" role="listbox" aria-label={t.themeSheet.section}>
          {shown.map((th, i) => {
            const inUse = th.id === current;
            return (
              <button key={th.id} id={`theme-${th.id}`} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                className={`palette-item theme-item ${i === active ? 'is-active' : ''} ${inUse ? 'is-current' : ''}`}
                onMouseMove={() => { if (i !== active) move(i); }} onClick={() => keep(th)}>
                <span className="palette-cmd"><Icon name={inUse ? 'check' : 'appearance'} size={11} stroke={2} /></span>
                <span className="palette-label">{th.name}</span>
                <span className="palette-hint">{t.set.themeKinds[th.appearance]}{inUse ? ` · ${t.themeSheet.inUse}` : ''}</span>
                <ThemeThumb id={th.id} />
              </button>
            );
          })}
          {shown.length === 0 && <p className="empty">{t.themeSheet.empty}</p>}
        </div>
      </div>
    </div>
  );
}
