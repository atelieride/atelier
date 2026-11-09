// The filter popover: "+ Filter" opens it on the column list
// (searchable, with types; ↑/↓ and Enter pick), a chip on its own editor — the operator, then the value editor that
// operator takes (filters.ts valueEditor), checked as main checks it before Apply (inline problems). Keyboard-complete:
// Tab goes round its fields, Enter applies, Esc cancels and gives the keyboard back to the chip or "+ Filter" — on the
// popover itself, as the app's confirms (onEscCancel): nothing else in the window hears it. A press outside closes it.
// Placed inside its tab, under its anchor, within the window (a 600 px window, a 430 px pane: it scrolls inside).
// Mask values on, an existing filter's boolean or enum choice isn't shown until the user makes another. Lazy,
// with the table's chunk.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { arity, typeClass, type DbColumn, type DbDerived, type DbFilter, type DbFilterOp } from '@shared/databases-filters';
import { MASK } from '@shared/pg-format';
import { pathSql } from '@shared/pg-json';
import { Icon, type IconName } from '../components/Icon';
import { tdt } from '../i18n/db-table';
import { radioNext } from '../radio';
import { setFilters, type FilterPop } from './filter-actions';
import {
  addFilter, commitPending, draftFilter, draftFor, draftOf, enumItems, enumToggle, filterMasked, filterTargets, matchTargets, opChoice, opChoices, parsePath,
  removeFilter, replaceFilter, valueEditor, withOp, type Draft, type DraftField, type FilterTarget
} from './filters';
import { CheckList, entersApply, trapTab, useOutside, usePlaced } from './popover-kit';
import { useDb } from './store';

const tf = tdt.filters;
const WIDTH = 340;
const PICKS = { days: ['1', '7', '30', '90'], hours: ['1', '6', '12', '24'] } as const;

const targetIcon = (t: FilterTarget): IconName | null => (t.path ? 'jsonBranch' : t.col.isPk ? 'key' : t.col.fk ? 'fkArrow' : null);

/** A filter's place among the targets: its column (the path stays in the draft); null when the table no longer has it. */
const targetOf = (f: DbFilter, ts: readonly FilterTarget[]) => ts.find((t) => t.path === null && t.col.name === f.column) ?? null;

export function FilterPopover({ tabKey, pop, filters, cols, derived, masked, onClose }: {
  tabKey: string; pop: FilterPop; filters: readonly DbFilter[]; cols: readonly DbColumn[]; derived: readonly DbDerived[]; masked: boolean;
  /** `focus`: the bar's element to give the keyboard back to (null: leave it where it is — a press elsewhere). */
  onClose: (focus: string | null) => void;
}) {
  const editing = pop.edit !== null ? filters[pop.edit] ?? null : null;
  const targets = useMemo(() => filterTargets(cols, derived), [cols, derived]);
  const [target, setTarget] = useState<FilterTarget | null>(() => (editing ? targetOf(editing, targets) : pop.target ? targets.find((t) => t.key === pop.target) ?? null : null));
  const [draft, setDraft] = useState<Draft | null>(() => (editing ? draftOf(editing) : target ? draftFor(target.col, target.path) : null));
  const [tried, setTried] = useState(false);
  // Back to the list keeps the column and what was typed: picking the same one again finds them.
  const [picking, setPicking] = useState(false);
  // An existing filter's choice, until the user makes another (hidden while its column is masked).
  const [touched, setTouched] = useState(editing === null);
  // "Is any of" a text: what is still in its field — Apply counts it.
  const [pending, setPending] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // A filter whose column the table no longer has: its own step (say so, Remove).
  const step: 'pick' | 'edit' | 'gone' = picking ? 'pick' : target && draft ? 'edit' : editing ? 'gone' : 'pick';
  usePlaced(box, [pop.anchor, 'more', 'add'], WIDTH, [pop.anchor, step, draft?.op]);
  useOutside(box, pop.anchor, () => onClose(null));
  // The first field takes the keyboard on each step (the search, or the value — the operator when there is none).
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('select');
    el?.focus({ preventScroll: true });
  }, [step]);

  const colMasked = step === 'edit' && filterMasked({ column: target!.col.name, path: parsePath(draft!.path) ?? target!.path ?? undefined }, masked);
  const hidden = colMasked && !touched;
  // What Apply sends: the draft, with an "is any of" field's pending text.
  const full = step === 'edit' && valueEditor(target!.col, draft!.op) === 'checklist' ? { ...draft!, values: commitPending(draft!.values, pending) } : draft;
  const result = step === 'edit' ? draftFilter(target!.col, full!) : null;
  const problem = tried && result && !result.ok ? result : null;

  const pick = (t: FilterTarget) => {
    if (!(draft && target && target.key === t.key)) {
      setDraft(editing && editing.column === t.col.name && !t.path ? draftOf(editing) : draftFor(t.col, t.path));
      setTouched(!(editing && editing.column === t.col.name && !t.path));
    }
    setTarget(t);
    setPicking(false);
    setTried(false);
  };
  const back = () => { setPicking(true); setTried(false); };
  const apply = () => {
    if (!result) return;
    if (!result.ok) {
      setTried(true);
      box.current?.querySelector<HTMLElement>(`[data-field="${result.field}"]`)?.focus();
      return;
    }
    const list = useDb.getState().tab(tabKey).filters;
    setFilters(tabKey, pop.edit === null ? addFilter(list, result.filter) : replaceFilter(list, pop.edit, result.filter));
    onClose(pop.anchor);
  };
  const remove = () => {
    if (pop.edit === null) return;
    const list = useDb.getState().tab(tabKey).filters;
    const next = removeFilter(list, pop.edit);
    setFilters(tabKey, next);
    onClose(next.length > pop.edit ? `chip-${pop.edit}` : next.length > 0 ? `chip-${next.length - 1}` : 'add');
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(pop.anchor);
      return;
    }
    trapTab(e);
    if (e.key === 'Enter' && step === 'edit' && !e.repeat && !e.nativeEvent.isComposing && entersApply(e.target)) {
      e.preventDefault();
      apply();
    }
  };

  const title = editing ? tf.editTitle : tf.addTitle;
  return (
    <div ref={box} className="dbt-fpop" role="dialog" aria-label={title} style={{ visibility: 'hidden' }} onKeyDown={onKey}>
      {step === 'pick' && <ColumnPick targets={targets} current={target?.key ?? null} onPick={pick} />}
      {step === 'edit' && (
        <Editor target={target!} draft={draft!} masked={colMasked} hidden={hidden} pending={pending} problem={problem}
          onDraft={setDraft} onTouch={() => setTouched(true)} onPending={setPending} onBack={back} />
      )}
      {step === 'gone' && editing && (
        <>
          <div className="dbt-fpop-head">
            <button type="button" className="dbt-fpop-col" data-autofocus aria-label={`${tf.back}: ${editing.column}`} data-tip={tf.back} onClick={back}>
              <Icon name="chevronLeft" size={12} />
              <span className="dbt-fpop-colname">{editing.column}</span>
            </button>
          </div>
          <div className="dbt-fpop-body">
            <p className="dbt-fpop-note"><Icon name="info" size={13} /><span>{tf.goneColumn}</span></p>
          </div>
        </>
      )}
      {step !== 'pick' && (
        <div className="dbt-fpop-foot">
          {editing && <button type="button" className="btn-ghost sm dbt-fpop-remove" onClick={remove}><Icon name="trash" size={12} />{tf.remove}</button>}
          <span className="dbt-sp" />
          <button type="button" className="btn-ghost sm" onClick={() => onClose(pop.anchor)}>{tf.cancel}</button>
          {step === 'edit' && <button type="button" className="btn-primary sm" onClick={apply}>{tf.apply}</button>}
        </div>
      )}
    </div>
  );
}

/** The first step: the columns (and JSON columns), typed to find one; ↑/↓ and Enter, or a click, pick it. */
function ColumnPick({ targets, current, onPick }: { targets: readonly FilterTarget[]; current: string | null; onPick: (t: FilterTarget) => void }) {
  const [q, setQ] = useState('');
  // Back from the editor: the column it had is the one Enter picks again.
  const [active, setActive] = useState(() => Math.max(0, targets.findIndex((t) => t.key === current)));
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => matchTargets(targets, q), [targets, q]);
  const cur = Math.min(active, Math.max(0, shown.length - 1));
  const go = (i: number) => {
    setActive(i);
    list.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  useLayoutEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, []);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length > 0) go(e.key === 'ArrowDown' ? Math.min(shown.length - 1, cur + 1) : Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && !e.repeat && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const t = shown[cur];
      if (t) onPick(t);
    }
  };
  const id = 'dbt-fcols';
  return (
    <>
      <div className="dbt-fpop-find db-input">
        <Icon name="search" size={14} />
        <input data-autofocus value={q} placeholder={tf.findColumn} aria-label={tf.findColumn} role="combobox" aria-expanded="true" aria-controls={id}
          aria-activedescendant={shown[cur] ? `${id}-${cur}` : undefined} spellCheck={false} autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
      </div>
      <div ref={list} id={id} className="dbt-fpop-list" role="listbox" aria-label={tf.columnsLabel}>
        {shown.map((t, i) => {
          const icon = targetIcon(t);
          return (
            <div key={t.key} id={`${id}-${i}`} data-i={i} role="option" aria-selected={i === cur} className={`dbt-fcol${i === cur ? ' is-active' : ''}${t.path ? ' is-drv' : ''}`}
              data-tip={`${t.label} · ${t.col.type}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(t)}>
              <span className={`dbt-fcol-icon${icon ? ` is-${icon}` : ''}`} aria-hidden="true">{icon && <Icon name={icon} size={12} />}</span>
              <span className="dbt-fcol-name">{t.label}</span><span className="dbt-fcol-type">{t.type}</span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="dbt-fpop-empty">{tf.noColumn}</div>}
      </div>
    </>
  );
}

/**
 * The second step: the column (a click goes back to the list), the operator, the value editor, the problem. `masked`:
 * the column's values are typed as dots; `hidden`: a boolean's or an enum's existing choice isn't shown.
 */
function Editor({ target, draft, masked, hidden, pending, problem, onDraft, onTouch, onPending, onBack }: {
  target: FilterTarget; draft: Draft; masked: boolean; hidden: boolean; pending: string; problem: { problem: string; field: DraftField } | null;
  onDraft: (d: Draft) => void; onTouch: () => void; onPending: (text: string) => void; onBack: () => void;
}) {
  const c = target.col;
  const ed = valueEditor(c, draft.op);
  const choices = opChoices(c);
  const setValue = (i: number, v: string) => {
    const values = [...draft.values];
    values[i] = v;
    onDraft({ ...draft, values });
  };
  const bad = (f: DraftField) => problem?.field === f;
  const errId = 'dbt-fpop-err';
  const field = (f: number, o: { label: string; hint: string; numeric?: boolean; autofocus?: boolean }) => (
    <div className={`db-input dbt-fpop-input${bad(f) ? ' is-invalid' : ''}`}>
      <input data-field={f} data-autofocus={o.autofocus || undefined} className={masked ? 'is-masked' : undefined} value={draft.values[f] ?? ''} placeholder={o.hint}
        aria-label={o.label} aria-invalid={bad(f) || undefined} aria-describedby={bad(f) ? errId : undefined} inputMode={o.numeric ? 'decimal' : undefined}
        spellCheck={false} autoComplete="off" onChange={(e) => setValue(f, e.target.value)} />
    </div>
  );
  const isNum = ed === 'number' || (ed === 'two' && typeClass(c) === 'number');
  const hint = isNum ? tf.numberHint : typeClass(c) === 'time' ? tf.timeHint : tf.valueHint;
  const enumList = c.enumValues && c.enumValues.length > 0 ? c.enumValues : null;
  let body: ReactNode = null;
  switch (ed) {
    case 'text': case 'number':
      body = field(0, { label: tf.value, hint, numeric: isNum, autofocus: true });
      break;
    case 'two':
      body = (
        <div className="dbt-fpop-two">
          {field(0, { label: tf.from, hint, numeric: isNum, autofocus: true })}
          <span className="dbt-fpop-dash" aria-hidden="true">–</span>
          {field(1, { label: tf.to, hint, numeric: isNum })}
        </div>
      );
      break;
    case 'bool':
      body = <BoolSwitch value={hidden ? null : draft.op === 'false' ? 'false' : 'true'} onPick={(v) => { onTouch(); onDraft(withOp(draft, c, v)); }} />;
      break;
    case 'days': case 'hours':
      body = <Count draft={draft} unit={ed} invalid={bad(0)} errId={errId} onValue={(v) => setValue(0, v)} />;
      break;
    case 'checklist':
      body = enumList
        ? <EnumValues catalog={enumList} chosen={draft.values} hidden={hidden} onChange={(values) => { onTouch(); onDraft({ ...draft, values }); }} />
        : <TypedValues values={draft.values} pending={pending} masked={masked} invalid={bad('values')} onChange={(values) => onDraft({ ...draft, values })} onPending={onPending} />;
      break;
    case 'path': {
      const p = parsePath(draft.path);
      // As main runs it: the text at the path, or the JSON there for "exists" (#> … IS NOT NULL) and "is JSON null".
      const sql = !p || p.length === 0 ? null
        : draft.op === 'pathExists' ? `${pathSql(c.name, p, '#>')} IS NOT NULL`
          : draft.op === 'pathNull' ? `(${pathSql(c.name, p, '#>')})::jsonb = 'null'::jsonb` : pathSql(c.name, p);
      body = (
        <>
          <div className={`db-input dbt-fpop-input${bad('path') ? ' is-invalid' : ''}`}>
            <span className="dbt-fpop-tag">{tf.path}</span>
            <input data-field="path" data-autofocus={!target.path || undefined} value={draft.path} placeholder={tf.pathHint} aria-label={tf.path}
              aria-invalid={bad('path') || undefined} aria-describedby={bad('path') ? errId : undefined} spellCheck={false} autoComplete="off"
              onChange={(e) => onDraft({ ...draft, path: e.target.value })} />
          </div>
          {sql && <code className="dbt-fpop-sql mono">{sql}</code>}
          {arity(draft.op) !== 0 && field(0, { label: tf.value, hint: tf.valueHint, autofocus: !!target.path })}
        </>
      );
      break;
    }
    case 'none':
      break;
  }
  return (
    <>
      <div className="dbt-fpop-head">
        <button type="button" className="dbt-fpop-col" aria-label={`${tf.back}: ${target.label}`} data-tip={tf.back} onClick={onBack}>
          <Icon name="chevronLeft" size={12} />
          <span className="dbt-fpop-colname">{target.label}</span>
          <span className="dbt-fpop-coltype">{target.type}</span>
        </button>
      </div>
      <div className="dbt-fpop-body">
        <div className="dbt-fpop-opbox">
          <select className="dbt-fpop-op" value={opChoice(draft.op)} aria-label={tf.op} onChange={(e) => onDraft(withOp(draft, c, e.target.value as DbFilterOp))}>
            {choices.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          <Icon name="chevronDown" size={12} />
        </div>
        {body}
        {hidden && (ed === 'bool' || (ed === 'checklist' && enumList)) && <p className="dbt-fpop-note"><Icon name="eye" size={13} /><span>{tf.maskedHint}</span></p>}
        {problem && <p id={errId} className="db-field-err dbt-fpop-err" role="alert">{problem.problem}</p>}
      </div>
    </>
  );
}

/**
 * A boolean's "is" true · false (a radio group: arrows choose). `value` null: nothing shown chosen — the Tab stop
 * on true, an arrow or a click chooses.
 */
function BoolSwitch({ value, onPick }: { value: 'true' | 'false' | null; onPick: (v: 'true' | 'false') => void }) {
  const opts = ['true', 'false'] as const;
  const stop = value ?? 'true';
  return (
    <div className="set-seg dbt-fpop-seg" role="radiogroup" aria-label={tf.value} onKeyDown={(e) => {
      const next = radioNext(opts, stop, e.key);
      if (next === null) return;
      e.preventDefault();
      onPick(next);
      (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus();
    }}>
      {opts.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} tabIndex={stop === o ? 0 : -1} data-value={o}
          className={`set-seg-opt${value === o ? ' is-on' : ''}`} onClick={() => onPick(o)}>{o}</button>
      ))}
    </div>
  );
}

/** In the last N days / hours: the count, its unit, quick picks. */
function Count({ draft, unit, invalid, errId, onValue }: { draft: Draft; unit: 'days' | 'hours'; invalid: boolean; errId: string; onValue: (v: string) => void }) {
  const v = draft.values[0] ?? '';
  return (
    <>
      <div className="dbt-fpop-count">
        <div className={`db-input dbt-fpop-input dbt-fpop-n${invalid ? ' is-invalid' : ''}`}>
          <input data-field={0} data-autofocus inputMode="numeric" value={v} aria-label={tf.unit[unit]} aria-invalid={invalid || undefined} aria-describedby={invalid ? errId : undefined}
            spellCheck={false} autoComplete="off" onChange={(e) => onValue(e.target.value)} />
        </div>
        <span className="dbt-fpop-unit">{tf.unit[unit]}</span>
      </div>
      <div className="dbt-fpop-picks" role="group" aria-label={tf.picks}>
        {PICKS[unit].map((n) => <button key={n} type="button" className={`dbt-fpop-pick${v === n ? ' is-on' : ''}`} aria-pressed={v === n} onClick={() => onValue(n)}>{n}</button>)}
      </div>
    </>
  );
}

/**
 * An enum's values (from the catalog), checked, then a chosen one the type no longer has (marked, to uncheck); a find
 * field past eight of them. `hidden`: nothing checked until the user chooses again.
 */
function EnumValues({ catalog, chosen, hidden, onChange }: { catalog: readonly string[]; chosen: readonly string[]; hidden: boolean; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const s = q.trim().toLowerCase();
  const items = enumItems(catalog, chosen, hidden).filter((it) => !s || it.value.toLowerCase().includes(s));
  return (
    <>
      {catalog.length > 8 && (
        <div className="db-input dbt-fpop-input">
          <Icon name="search" size={13} />
          <input data-autofocus value={q} placeholder={tf.findValue} aria-label={tf.findValue} spellCheck={false} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="dbt-fpop-checks">
        <CheckList label={tf.value} field="values" autoFocus={catalog.length <= 8} items={items} onToggle={(v) => onChange(enumToggle(catalog, chosen, v, hidden))} />
      </div>
    </>
  );
}

/**
 * "Is any of" a text: values typed one at a time (Enter adds; a paste of lines adds each), each removable. What is still
 * in the field (`pending`, the popover's) is added when the field is left, and Apply counts it.
 */
function TypedValues({ values, pending, masked, invalid, onChange, onPending }: {
  values: readonly string[]; pending: string; masked: boolean; invalid: boolean; onChange: (v: string[]) => void; onPending: (text: string) => void;
}) {
  const commit = () => {
    if (pending === '') return;
    onChange(commitPending(values, pending));
    onPending('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter with something typed adds it; with nothing typed it applies (the popover hears it).
    if (e.key !== 'Enter' || pending === '' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    commit();
  };
  return (
    <>
      <div className={`db-input dbt-fpop-input${invalid ? ' is-invalid' : ''}`}>
        <input data-field="values" data-autofocus className={masked ? 'is-masked' : undefined} value={pending} placeholder={tf.addValue} aria-label={tf.addValue}
          data-tip={tf.addValueTip} spellCheck={false} autoComplete="off" onKeyDown={onKey} onChange={(e) => onPending(e.target.value)}
          // Left for Apply or Cancel, the text stays pending (Apply counts it): added on the way, its token would grow
          // the popover under the pointer and the press would land beside Apply (the e2e).
          onBlur={(e) => { if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('.dbt-fpop-foot'))) commit(); }}
          onPaste={(e) => {
            // A field of one line would join the lines: each one is a value.
            const pasted = e.clipboardData.getData('text');
            if (!/\r?\n/.test(pasted)) return;
            e.preventDefault();
            onChange(commitPending(values, pasted));
          }} />
      </div>
      {values.length > 0 && (
        <div className="dbt-fpop-tokens">
          {values.map((v) => (
            <span key={v} className="dbt-fpop-token">
              <span className="dbt-fpop-token-v">{masked ? MASK : v === '' ? tf.emptyValue : v}</span>
              <button type="button" className="dbt-fpop-token-x" aria-label={tf.removeValue(masked ? MASK : v)} onClick={() => onChange(values.filter((x) => x !== v))}>
                <Icon name="x" size={10} stroke={2} />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
