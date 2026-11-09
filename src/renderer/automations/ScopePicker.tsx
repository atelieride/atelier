// The editor's "Add List…": a button opening a searchable popover of the places
// to watch not chosen yet (ClickUp's lists by path, Notion's databases, Jira's projects); ↑↓ move, Enter adds one, Esc
// or Tab closes it only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@shared/fuzzy';
import type { ConnectorId } from '@shared/tasks';
import { stepActive } from '../palette-query';
import { t } from '../i18n/en';
import { Icon } from '../components/Icon';
import { ChoicePopover } from './ChoicePopover';

const te = t.auto.editor;
const MAX_SHOWN = 300;

export function ScopePicker({ connector, label, scopes, chosen, onAdd }: {
  connector: ConnectorId; label: string; scopes: readonly { id: string; label: string }[]; chosen: readonly string[]; onAdd: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => fuzzyFilter(scopes.filter((s) => !chosen.includes(s.id)), query.trim(), (s) => s.label, MAX_SHOWN), [scopes, chosen, query]);

  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus(); };
  const pick = (id: string | undefined) => { if (id) { onAdd(id); close(true); } };

  return (
    <>
      <button ref={button} type="button" className={`btn-small is-ghost ae-add-scope ${open ? 'is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { if (open) close(false); else { setQuery(''); setActive(0); setOpen(true); } }}>
        <Icon name="plus" size={11} />{label}
      </button>
      {open && button.current && (
        <ChoicePopover anchor={button.current} minWidth={380} onClose={() => close(false)}>
          <div className="ae-pop-search">
            <Icon name="search" size={12} />
            <input autoFocus className="ae-pop-input" value={query} placeholder={te.searchScopes(connector)} spellCheck={false} aria-label={te.searchScopes(connector)}
              role="combobox" aria-expanded="true" aria-controls="ae-scope-list" aria-activedescendant={rows.length ? `ae-scope-${active}` : undefined}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
                // Tab moves on from the button (the popover sits at the end of the page).
                else if (e.key === 'Tab') close(true);
                else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => stepActive(a, 1, rows.length)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, rows.length)); }
                else if (e.key === 'Enter') { e.preventDefault(); pick(rows[active]?.id); }
              }} />
          </div>
          <div ref={list} id="ae-scope-list" className="ae-pop-list" role="listbox" aria-label={label}>
            {rows.map((s, i) => (
              <button key={s.id} id={`ae-scope-${i}`} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                className={`ae-pop-row ${i === active ? 'is-active' : ''}`} onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => pick(s.id)}>
                <span className="ae-pop-ic"><Icon name={connector} size={11} /></span>
                <span className="ae-pop-label">{s.label}</span>
              </button>
            ))}
            {rows.length === 0 && <p className="ae-pop-empty">{scopes.length === 0 ? te.scopesLoading : te.noScope}</p>}
          </div>
        </ChoicePopover>
      )}
    </>
  );
}
