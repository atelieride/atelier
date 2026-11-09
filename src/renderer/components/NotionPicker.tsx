// "Add Database…": a floating panel over the dimmed details page. Typing searches
// Notion's databases (250 ms after the last key, 2+ characters); a pasted link offers "Add this database" (Notion's
// index lags for new databases, the link always works). ↑ ↓ move, ↵ adds, Esc or a click outside closes it — Esc only
// the picker: Settings stays open ([data-own-esc]). A search failure or a refusal is one line here, never a toast.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectorInfo, SourcePick } from '@shared/tasks';
import { t } from '../i18n/en';
import { addErrorText, canAdd, linkRefusal, pickerRows, searchText, shouldSearch, type PickerRow } from '../notion-view';
import { Icon } from './Icon';

const n = t.conn.notion;
const DEBOUNCE_MS = 250;

interface Props {
  c: ConnectorInfo;
  onClose(): void;
  /** Added (or already there): the sources it stands for. */
  onAdded(sourceIds: string[]): void;
}

export function NotionPicker({ c, onClose, onAdded }: Props) {
  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState<SourcePick[]>([]);
  const [searching, setSearching] = useState(false);
  // The text the shown results answer (null: nothing searched yet).
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const rows = pickerRows(query, picks);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const my = ++seq.current;
    if (!shouldSearch(query)) { setSearching(false); setPicks([]); setAnswered(null); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      window.atelier.connectors.searchSources(c.id, searchText(query)).then(
        (found) => { if (seq.current === my) { setPicks(found); setAnswered(query); setSearching(false); setActive(0); } },
        () => { if (seq.current === my) { setPicks([]); setAnswered(query); setSearching(false); setError(n.searchFailed); } }
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, c.id]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const add = async (row: PickerRow) => {
    if (adding) return;
    const refused = linkRefusal(row);
    setError(refused);
    if (refused) return;
    setAdding(row.key);
    try {
      const r = await window.atelier.connectors.addSource(c.id, row.kind === 'link' ? row.ref : row.pick.id);
      if (r.ok) { onAdded(r.sourceIds); return; }
      setError(addErrorText(r.reason, c.name));
    } catch {
      setError(addErrorText('failed', c.name));
    }
    setAdding(null);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    // Results are reached with the arrows: Tab stays in the field (the page behind is dimmed).
    if (e.key === 'Tab') { e.preventDefault(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setActive((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // During the debounce the rows still answer the previous text: Enter waits for the new results.
      const row = rows[at];
      if (row && canAdd(row, query, answered)) void add(row);
    }
  };

  const line = error
    ? <p className="nsp-line is-err" role="alert"><Icon name="warning" size={13} stroke={1.9} />{error}</p>
    : rows.length === 0 && searching ? <p className="nsp-line">{n.searching}</p>
      : rows.length === 0 && answered !== null ? <p className="nsp-line">{n.noMatch}</p> : null;
  const optionId = (i: number) => `nsp-opt-${i}`;

  return (
    <div className="nsp-layer" data-own-esc="" onKeyDown={onKey}>
      <div className="nsp-dim" aria-hidden="true" onMouseDown={onClose} />
      {/* A click on the panel's text or padding keeps the focus in the field (it never drops to the page). */}
      <div className="nsp" role="dialog" aria-modal="true" aria-label={n.pickerLabel} tabIndex={-1}
        onMouseDown={(e) => { if (e.target !== input.current) e.preventDefault(); }}>
        <div className="nsp-search">
          <Icon name="search" size={16} stroke={1.9} />
          <input ref={input} className="nsp-input" value={query} placeholder={n.placeholder} aria-label={n.searchLabel} spellCheck={false}
            role="combobox" aria-expanded={rows.length > 0} aria-controls={rows.length > 0 ? 'nsp-list' : undefined} aria-autocomplete="list"
            aria-activedescendant={rows[at] ? optionId(at) : undefined}
            onChange={(e) => { setQuery(e.target.value); setError(null); setActive(0); }} />
          {c.workspace && <span className="nsp-ws">{c.workspace}</span>}
        </div>
        {(rows.length > 0 || line) && (
          <div className="nsp-body" ref={list}>
            {rows.length > 0 && rows[0]!.kind === 'pick' && <div className="nsp-label" aria-hidden="true">{n.results}</div>}
            <div className="nsp-list" id="nsp-list" role="listbox" aria-label={n.results}>
              {rows.map((row, i) => (
                <PickerItem key={row.key} row={row} index={i} id={optionId(i)} active={i === at} adding={adding === row.key}
                  onHover={() => setActive(i)} onPick={() => void add(row)} />
              ))}
            </div>
            {line}
          </div>
        )}
        <div className="nsp-foot">
          <span>{n.notListed}</span>
          <span className="nsp-keys"><span><kbd>↵</kbd> {n.keyAdd}</span><span><kbd>esc</kbd> {n.keyClose}</span></span>
        </div>
      </div>
    </div>
  );
}

function PickerItem({ row, index, id, active, adding, onHover, onPick }: {
  row: PickerRow; index: number; id: string; active: boolean; adding: boolean; onHover(): void; onPick(): void;
}) {
  const pick = row.kind === 'pick' ? row.pick : null;
  const right = adding ? <span className="nsp-hint">{n.adding}</span>
    : pick?.added ? <span className="nsp-added"><Icon name="check" size={13} stroke={2.2} />{n.added}</span>
      : active ? <span className="nsp-hint">{n.addHint}</span> : null;
  return (
    // Not a Tab stop: the field keeps the focus (the mouse down doesn't take it either).
    <button type="button" id={id} role="option" aria-selected={active} tabIndex={-1} data-index={index}
      className={`nsp-item${active ? ' is-active' : ''}`} onMouseMove={onHover} onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <span className="nsp-glyph" aria-hidden="true"><Icon name={pick ? 'database' : 'plus'} size={14} stroke={1.9} /></span>
      <span className="nsp-text">
        <span className="nsp-name">{pick ? pick.name : n.addLink}</span>
        {pick ? pick.path && <span className="nsp-path">{pick.path}</span> : <span className="nsp-path mono">{row.kind === 'link' ? row.ref : ''}</span>}
      </span>
      {right}
    </button>
  );
}
