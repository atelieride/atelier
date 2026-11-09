// The record view (Tab on a row, as a database client's record view shows a row full screen): in the rows' place, one
// row — "Row N of M loaded" and its key in the head — with every column, one field a line: name and type line on the
// left, the value whole on the right (wrapping; a cut one with its Load full value), JSON as the inspector's lossless tree,
//a foreign key's value with its peek card, the columns the grid's chooser hides after the others (read for
// this row by its key; a table without one: only the fields loaded, and the inspector's note), every mask as the
// inspector's. The fields and their reads are the inspector's own (Inspector.tsx: useRowData, FieldRow). ↑/↓ the
// previous and next row (on the last one loaded the next fetch is asked for, as the grid does near its end; at the end it
// stays), Tab or Esc back to the grid on that row (record.ts); Shift+Tab moves the focus as usual; PageUp, PageDown, Home,
// End and Space scroll the record. Its keys are its own element's: no window listener, nothing taken from terminals,
// editors or fields. Lazy, with the table's chunk and its stylesheet.
import './record.css';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { isMod } from '@shared/keys';
import type { DbTimes } from '@shared/pg-format';
import { Icon } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { kbd } from '../kbd';
import { loadMore } from './data';
import { Failed, FieldRow, useRowData } from './Inspector';
import { closeRecord, isTyping, moveRecord, recordKey, recordRow, takeKeys, wantsMore } from './record';
import type { DbTabState } from './store';
import type { DbTabRef } from './tabs';

export interface RecordViewProps { tab: DbTabRef; st: DbTabState; masked: boolean; times: DbTimes; visible: boolean }

export function RecordView({ tab, st, masked, times, visible }: RecordViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const n = st.rows.length;
  const index = recordRow(st);
  const d = useRowData({ tab, st, index, masked, times, visible, more: true, refs: false, jsonView: false });

  // The keyboard: the key that opened it asked for it (Tab on a grid row), or the tab itself had it (shown again, its
  // rows back after a failed read). A click on the toolbar's Record leaves it on the toggle.
  useLayoutEffect(() => {
    const tabEl = box.current?.closest('.dbt');
    if (takeKeys(tab.key, 'record') || (tabEl && document.activeElement === tabEl)) body.current?.focus({ preventScroll: true });
  }, []);
  // Another row: from its top.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [index, st.reqId]);
  // On the last row loaded: the next fetch, as the grid asks near its end (idle only: never after an error).
  useEffect(() => {
    if (visible && wantsMore(index, n, st.more)) void loadMore(tab.key);
  }, [visible, index, n, st.more, tab.key]);

  const move = (step: 1 | -1) => moveRecord(tab.key, step);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const act = recordKey({ key: e.key, shift: e.shiftKey, mod: isMod(e), alt: e.altKey, ctrl: e.ctrlKey }, isTyping(e.target));
    if (!act) return;
    // The record view's own: nothing else in the window hears it.
    e.preventDefault();
    e.stopPropagation();
    if (act === 'back') { closeRecord(tab.key, true); return; }
    // The control under the keyboard may go with the row: the record keeps the keyboard.
    if (e.target !== body.current) body.current?.focus({ preventScroll: true });
    move(act === 'next' ? 1 : -1);
  };

  if (index === null) return null;
  const c = d.c;
  // The columns the chooser hides (and the keys main added to name the row): read by the row's key; without one, only
  // those loaded show.
  const hiddenNames = d.key ? d.order.more : d.order.more.filter((name) => d.fields.has(name));
  const unread = !d.key && d.order.more.some((name) => !d.fields.has(name));
  const keyText = d.key ? d.keyText : '';
  return (
    <div ref={box} className={`dbrv${st.loading ? ' is-busy' : ''}`} onKeyDown={onKeyDown}>
      <div className="dbrv-head">
        <span className="dbrv-icon" aria-hidden="true"><Icon name="record" size={14} /></span>
        <span className="dbrv-pos" data-tip={tdt.record.at(index + 1, n)}>{tdt.record.at(index + 1, n)}</span>
        {keyText && <span className="dbrv-key mono" data-tip={keyText}>{keyText}</span>}
        <span className="dbrv-sp" />
        <button type="button" className="icon-btn dbrv-ib" aria-label={tdt.insp.prev} data-tip={tdt.insp.prev} data-kbd={kbd('↑')} disabled={index === 0} onClick={() => move(-1)}>
          <Icon name="arrowUp" size={14} />
        </button>
        <button type="button" className="icon-btn dbrv-ib" aria-label={tdt.insp.next} data-tip={tdt.insp.next} data-kbd={kbd('↓')} disabled={index >= n - 1} onClick={() => move(1)}>
          <Icon name="arrowDown" size={14} />
        </button>
      </div>
      <div ref={body} className="dbrv-body" tabIndex={0} role="group" aria-label={tdt.record.body(index + 1)}>
        {c && <>
          {d.order.shown.map((name) => <FieldRow key={name} c={c} name={name} field={d.fields.get(name)} fk={d.placed.get(name) ?? null} pending={d.pending} />)}
          {/* The grid's JSON columns, after the table's own. */}
          {d.derived.map((x) => <FieldRow key={x.key} c={c} name={x.name} fold={x.key} field={x.field} fk={null} pending={d.pending} />)}
          {(hiddenNames.length > 0 || unread) && <h3 className="section-label dbrv-sec">{tdt.record.hidden}</h3>}
          {unread && <p className="dbi-dim dbrv-note">{tdt.insp.noKeyMore}</p>}
          {d.gone && <p className="dbi-dim dbrv-note">{tdt.insp.gone}</p>}
          {d.rr?.more?.s === 'err' && <div className="dbrv-note"><Failed text={tdt.insp.failed(d.rr.more.p.message)} p={d.rr.more.p} onRetry={d.retryMore} /></div>}
          {hiddenNames.map((name) => <FieldRow key={name} c={c} name={name} field={d.fields.get(name)} fk={d.placed.get(name) ?? null} pending={d.pending} />)}
        </>}
      </div>
    </div>
  );
}
