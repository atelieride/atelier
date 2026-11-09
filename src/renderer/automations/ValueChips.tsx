// A condition's values as chips: Status, Tag, Assigned to, Created by. Typing
// filters the source's values in a popover under the field; ↑↓ move, Enter picks; Status and Tag also take typed text
// (Enter, a comma, or leaving the field); people only from the list, Me first. Backspace in an empty field removes the
// last chip; Esc closes the popover only.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Condition, ConditionValues } from '@shared/automations';
import { stepActive } from '../palette-query';
import { statusTone } from '../task-view';
import { t } from '../i18n/en';
import { Icon } from '../components/Icon';
import { ChoicePopover } from './ChoicePopover';
import { MAX_VALUES, addValue, isPeople, personName, removeValue, suggestions } from './chips';

const te = t.auto.editor;

export function ValueChips({ c, known, noun, onChange }: { c: Condition; known: ConditionValues | null; noun: string; onChange: (c: Condition) => void }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const people = isPeople(c.field);
  const full = c.values.length >= MAX_VALUES;
  const shown = useMemo(() => suggestions(c, text, known), [c, text, known]);
  const id = `ae-vals${useId().replace(/:/g, '')}`;

  useEffect(() => { list.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const add = (value: string) => { onChange(addValue(c, value, known)); setText(''); setActive(0); };
  /** Typed text as a value (Status, Tag): the source's own spelling when it has that name. */
  const addTyped = () => {
    const v = text.trim();
    if (!v || people) return;
    const same = [...(known?.status ?? []), ...(known?.tag ?? [])].find((o) => o.name.toLowerCase() === v.toLowerCase());
    add(same?.name ?? v);
  };
  /** A status the source has: its tone (a typed one it doesn't have gets no dot). */
  const tone = (value: string) => {
    const o = c.field === 'status' ? known?.status.find((x) => x.name.toLowerCase() === value.toLowerCase()) : undefined;
    return o ? statusTone(o.color) : null;
  };
  const name = (i: number) => (people ? personName(c, i, known) ?? te.someone : c.values[i]!);

  return (
    <>
      <div ref={field} className={`ae-vchips ${open ? 'is-open' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        {c.values.map((v, i) => {
          const tn = tone(v);
          const unknown = people && personName(c, i, known) === null;
          return (
            <span key={`${i}:${v}`} className={`ae-vchip ${people ? 'is-person' : ''}`} data-tip={unknown ? v : undefined}>
              {tn && <i className={`task-dot tone-${tn}`} />}
              {people && v !== 'me' && <Icon name="person" size={10} />}
              <span className="ae-vchip-name">{name(i)}</span>
              <button type="button" aria-label={te.removeValue(name(i))} onClick={() => { onChange(removeValue(c, i)); input.current?.focus(); }}><Icon name="x" size={9} /></button>
            </span>
          );
        })}
        <input ref={input} className="ae-vchips-input" value={text} spellCheck={false} readOnly={full}
          placeholder={full ? te.maxValues : c.values.length ? '' : te.addPlaceholder[c.field as keyof typeof te.addPlaceholder]}
          aria-label={t.auto.editor.fields[c.field]} role="combobox" aria-expanded={open} aria-controls={`${id}-list`}
          aria-activedescendant={open && shown.length ? `${id}-${active}` : undefined}
          onFocus={() => setOpen(true)}
          onBlur={() => { if (people) setText(''); else addTyped(); setOpen(false); }}
          onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => stepActive(a, 1, shown.length)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => stepActive(a, -1, shown.length)); }
            else if (e.key === 'Enter') {
              e.preventDefault();
              const s = open ? shown[Math.min(active, shown.length - 1)] : undefined;
              if (s) add(s.value); else addTyped();
            } else if (e.key === ',') { e.preventDefault(); addTyped(); }
            else if (e.key === 'Backspace' && text === '' && c.values.length) onChange(removeValue(c, c.values.length - 1));
          }} />
      </div>
      {open && !full && field.current && (
        <ChoicePopover anchor={field.current} minWidth={260} onClose={() => setOpen(false)}>
          <div ref={list} id={`${id}-list`} className="ae-pop-list" role="listbox" aria-label={t.auto.editor.fields[c.field]}>
            {shown.map((s, i) => (
              <button key={`${s.kind}:${s.value}`} id={`${id}-${i}`} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                className={`ae-pop-row ${i === active ? 'is-active' : ''} ${s.kind === 'add' ? 'is-add' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => add(s.value)}>
                {s.kind === 'add' ? <span className="ae-pop-ic"><Icon name="plus" size={11} stroke={2} /></span>
                  : c.field === 'status' ? <i className={`task-dot tone-${statusTone(s.color)}`} />
                  : people ? <span className="ae-pop-ic"><Icon name="person" size={11} /></span>
                  : <span className="ae-pop-ic"><Icon name="tag" size={11} /></span>}
                <span className="ae-pop-label">{s.label}</span>
                {s.kind === 'value' && s.count !== undefined && <span className="ae-pop-hint mono">{te.inUse(s.count)}</span>}
              </button>
            ))}
            {shown.length === 0 && (
              <p className="ae-pop-empty">{people ? (text.trim() ? te.noOne : known ? te.noOneElse : te.pickToSee(noun)) : te.noValues}</p>
            )}
            {people && shown.length > 0 && !known && <p className="ae-pop-empty">{te.pickToSee(noun)}</p>}
          </div>
        </ChoicePopover>
      )}
    </>
  );
}
