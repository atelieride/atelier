import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import { LANGUAGES, languageFor, languageLabel, type LanguageId } from '@shared/languages';
import { effectiveLanguage } from '../lang-overrides';
import { stepActive } from '../palette-query';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';

interface Choice { id: LanguageId | null; label: string; hint: string }

/**
 * Change Language Mode: the top sheet (same look as the palette) listing what the editor can highlight, "Auto (from
 * extension)" first. Fuzzy search, arrows wrap, Enter picks, Esc or a click outside closes. The tab's current language
 * is marked and selected when the sheet opens.
 */
export function LanguageSheet({ path }: { path: string }) {
  const close = () => useApp.getState().setLanguageSheet(null);
  const name = useApp((s) => s.openFiles.find((f) => f.path === path)?.rel.split('/').at(-1) ?? path);
  const current = useApp((s) => effectiveLanguage(path, s.langOverrides));
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const choices = useMemo<Choice[]>(() => [
    { id: null, label: t.lang.auto, hint: languageLabel(languageFor(path)) ?? t.plain },
    ...LANGUAGES.map((l) => ({ id: l.id, label: l.label, hint: l.ext ? `.${l.ext}` : '' }))
  ], [path]);
  const shown = useMemo(() => fuzzyFilter(choices, query.trim(), (c) => c.label, choices.length), [choices, query]);
  const currentIndex = Math.max(0, choices.findIndex((c) => c.id === current));
  const [active, setActive] = useState(currentIndex);

  useEffect(() => { input.current?.focus(); }, []);
  // The current language shows in the middle when the sheet opens; afterwards the list follows the arrows.
  const placed = useRef(false);
  useEffect(() => {
    list.current?.querySelector('.palette-item.is-active')?.scrollIntoView({ block: placed.current ? 'nearest' : 'center' });
    placed.current = true;
  }, [active, shown]);

  const pick = (c: Choice | undefined) => {
    if (!c) return;
    useApp.getState().setLanguage(path, c.id);
    close();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette language-sheet" role="dialog" aria-label={t.lang.title(name)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <span className="folder-sheet-icon"><FileIcon name={name} size={15} /></span>
          <span className="palette-mode">{t.lang.mode}</span>
          <input ref={input} className="palette-input" placeholder={t.lang.placeholder} value={query} spellCheck={false} aria-label={t.lang.title(name)}
            role="combobox" aria-expanded="true" aria-controls="language-list" aria-activedescendant={shown[active] ? `lang-${shown[active]!.id ?? 'auto'}` : undefined}
            // Searching starts from the best match; the empty list from the current language.
            onChange={(e) => { setQuery(e.target.value); setActive(e.target.value.trim() ? 0 : currentIndex); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); close(); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, shown.length)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, shown.length)); }
            }} />
          <span className="popover-hint mono">↑↓ ↵ · esc</span>
        </div>
        <div className="palette-list" ref={list} id="language-list" role="listbox" aria-label={t.lang.section}>
          {shown.map((c, i) => {
            const isCurrent = c.id === current;
            return (
              <button key={c.id ?? 'auto'} id={`lang-${c.id ?? 'auto'}`} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                className={`palette-item lang-item ${i === active ? 'is-active' : ''} ${isCurrent ? 'is-current' : ''} ${c.id === null ? 'is-auto' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => pick(c)}>
                <span className="palette-cmd"><Icon name={isCurrent ? 'check' : c.id === null ? 'sparkle' : 'code'} size={11} stroke={2} /></span>
                <span className="palette-label">{c.label}</span>
                <span className="palette-hint mono">{c.hint}</span>
              </button>
            );
          })}
          {shown.length === 0 && <p className="empty">{t.lang.empty}</p>}
        </div>
      </div>
    </div>
  );
}
