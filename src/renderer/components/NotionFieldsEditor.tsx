// A Notion database's fields, expanded in place under its row: which columns are the
// status (and which of its options mean done), whose tasks to list, the due date and the ID, with a live preview of
// the first task as the palette shows it. The selects are Settings' menu pattern (a button that opens the Aurora menu
// below it); every change goes straight to main (setSourceFields), which checks it against the database's schema.
import { useEffect, useState } from 'react';
import type { Column, ConnectorInfo, NotionFields, SourceInfo } from '@shared/tasks';
import { t } from '../i18n/en';
import { openBelow } from '../menus';
import type { MenuItem } from '../menu-model';
import { chooseColumn, columnTypeLabel, columnsFor, columnsView, doneChips, fieldColumn, previewRow, setMine, shownName, toggleClosed, type FieldKey } from '../notion-view';
import { Icon } from './Icon';
import { Segmented } from './Segmented';
import { TaskCells } from './TaskCells';

const n = t.conn.notion;

interface Props {
  id: string;
  c: ConnectorInfo;
  s: SourceInfo;
  fields: NotionFields;
  saving: boolean;
  /** The last edit was refused or never answered. */
  saveFailed: boolean;
  onChange(fields: NotionFields): void;
}

export function NotionFieldsEditor({ id, c, s, fields, saving, saveFailed, onChange }: Props) {
  // Opening reads the database's schema again, so the columns offered are Notion's current ones. A read that ends
  // without columns says so, with a Retry.
  const [read, setRead] = useState<'pending' | 'done'>('pending');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setRead('pending');
    window.atelier.connectors.loadSourceColumns(c.id, s.id).catch(() => null).finally(() => { if (live) setRead('done'); });
    return () => { live = false; };
  }, [c.id, s.id, attempt]);
  const cols = columnsView(s, read);
  const columnsLine = cols === 'reading' ? <span className="nsf-muted">{n.readingColumns}</span>
    : cols === 'failed' ? (
      <span className="nsf-muted nsf-fail">{n.columnsFailed}
        <button type="button" className="link-btn nsf-retry" onClick={() => setAttempt((a) => a + 1)}>{n.retry}</button>
      </span>
    ) : null;
  const row = previewRow(s);
  const chips = doneChips(fields, s.columns);
  const select = (key: FieldKey, label: string) => <ColumnSelect field={key} label={label} fields={fields} columns={s.columns} onChange={onChange} />;
  return (
    <div className="nsf" id={id} role="group" aria-label={n.fieldsLabel(s.name)}>
      <p className="nsf-guess"><Icon name="sparkle" size={13} stroke={1.9} />{n.picked}</p>
      {/* Without a status row to hold it, the columns' state gets a line of its own. */}
      {!fields.status && columnsLine && <p className="nsf-line">{columnsLine}</p>}
      <FieldRow label={n.status} hint={n.statusHint}>{select('status', n.status)}</FieldRow>
      {fields.status && (
        <FieldRow label={n.doneWhen} hint={n.doneWhenHint}>
          {chips ? (
            <div className="nsf-chips" role="group" aria-label={n.doneWhen}>
              {chips.chips.map((ch) => {
                const mark = ch.on ? <Icon name="check" size={11} stroke={2.4} /> : <i className={`nsf-sw tone-${ch.tone}`} aria-hidden="true" />;
                return chips.readOnly
                  ? (
                    <span key={ch.name} className={`nsf-opt is-static${ch.on ? ' is-on' : ''}`}>
                      {mark}<span aria-hidden="true">{shownName(ch.name)}</span><span className="sr-only">{ch.label}</span>
                    </span>
                  )
                  : (
                    // aria-disabled, not disabled: the cap's tooltip still shows and the chip stays reachable.
                    <button key={ch.name} type="button" className={`nsf-opt${ch.on ? ' is-on' : ''}`} aria-pressed={ch.on}
                      aria-disabled={ch.disabled || undefined} data-tip={ch.tip}
                      onClick={() => { if (!ch.disabled) onChange(toggleClosed(fields, ch.name)); }}>
                      {mark}{shownName(ch.name)}
                    </button>
                  );
              })}
              {chips.note && <span className="nsf-note">{chips.note}</span>}
            </div>
          ) : columnsLine}
        </FieldRow>
      )}
      <FieldRow label={n.assignedTo} hint={n.assignedToHint}>
        {select('assignee', n.assignedTo)}
        {fields.assignee && (
          <Segmented label={n.whose} value={fields.assignee.mine ? 'mine' : 'everyone'}
            options={[{ value: 'mine', label: n.mine }, { value: 'everyone', label: n.everyone }]}
            onChange={(v) => { if ((v === 'mine') !== fields.assignee!.mine) onChange(setMine(fields, v === 'mine')); }} />
        )}
      </FieldRow>
      <FieldRow label={n.due}>{select('due', n.due)}</FieldRow>
      <FieldRow label={n.id} hint={n.idHint}>{select('id', n.id)}</FieldRow>
      {saveFailed && <p className="nsf-line nsf-muted" role="status">{n.saveFailed}</p>}
      <div className={`nsf-preview${saving ? ' is-loading' : ''}`} role="group" aria-label={n.preview} aria-busy={saving || undefined}>
        <span className="nsf-preview-label" aria-hidden="true">{n.preview}</span>
        {row ? <TaskCells row={row} now={Date.now()} /> : <span className="nsf-muted">{n.noTasks}</span>}
      </div>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="nsf-row">
      <div className="nsf-label"><span className="nsf-name">{label}</span>{hint && <span className="nsf-hint">{hint}</span>}</div>
      <div className="nsf-control">{children}</div>
    </div>
  );
}

/** A column (name, quiet type, chevron) that opens the menu of the columns that fit, then None. */
function ColumnSelect({ field, label, fields, columns, onChange }: { field: FieldKey; label: string; fields: NotionFields; columns: Column[] | undefined; onChange(f: NotionFields): void }) {
  const current = fieldColumn(fields, field);
  const shown = current === null ? n.none : shownName(current);
  const choices = columnsFor(columns, field);
  const col = choices.find((x) => x.name === current);
  // The column already chosen: nothing to save.
  const pick = (x: Column | null) => { const next = chooseColumn(fields, field, x); if (next !== fields) onChange(next); };
  const items = (): MenuItem[] => [
    ...choices.map((x): MenuItem => ({
      id: `col:${x.name}`, label: shownName(x.name), hint: columnTypeLabel(x.type), ...(x.name === current ? { icon: 'check' as const } : {}),
      run: () => pick(x)
    })),
    ...(choices.length ? ['sep' as const] : []),
    { id: 'none', label: n.none, ...(current === null ? { icon: 'check' as const } : {}), run: () => pick(null) }
  ];
  return (
    // Disabled until the columns are read (they come with the editor's first loadSourceColumns).
    <button type="button" className="nsf-select" aria-haspopup="menu" aria-label={`${label}: ${shown}`} disabled={!columns}
      onClick={(e) => openBelow(e.currentTarget, items())}>
      <span className={`nsf-select-name${current === null ? ' is-none' : ''}`}>{shown}</span>
      {col && columnTypeLabel(col.type) && <span className="nsf-select-type">{columnTypeLabel(col.type)}</span>}
      <Icon name="chevronDown" size={12} stroke={2} />
    </button>
  );
}
