import { useEffect, useRef, useState } from 'react';
import { MAX_TRIGGERS, checkPattern, type TriggerAction, type TriggerRule, type TriggerScope } from '@shared/triggers';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { Icon } from './Icon';
import { Segmented } from './Segmented';
import { Toggle } from './Settings';

/** Settings › Terminal, scrolled to the triggers (palette "Edit output triggers…", the center's empty state). */
export function openTriggerSettings(): void {
  useApp.getState().setSettingsOpen('terminal');
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('.trg-section')?.scrollIntoView({ block: 'start' })));
}

/**
 * A rule being edited: `saved` is the last valid pattern main has (null for a new rule not saved yet). An invalid
 * pattern never reaches the settings: the saved one keeps working until the new one is valid.
 */
interface Draft { id: string; pattern: string; saved: string | null; action: TriggerAction; scope: TriggerScope; enabled: boolean }

const toDraft = (r: TriggerRule): Draft => ({ ...r, saved: r.pattern });
const newId = () => `t-${crypto.randomUUID().slice(0, 8)}`;

/** What main gets: valid patterns, or the last saved one while the field is invalid; new invalid rules not at all. */
function toRules(drafts: Draft[]): TriggerRule[] {
  const out: TriggerRule[] = [];
  for (const d of drafts) {
    const pattern = checkPattern(d.pattern).ok ? d.pattern : d.saved;
    if (pattern !== null) out.push({ id: d.id, pattern, action: d.action, scope: d.scope, enabled: d.enabled });
  }
  return out;
}

const opts = <V extends string>(labels: Record<V, string>) => (Object.keys(labels) as V[]).map((value) => ({ value, label: labels[value] }));

function Rule({ d, onChange, onCommit, onRemove, autoFocus }: { d: Draft; onChange: (d: Draft) => void; onCommit: () => void; onRemove: () => void; autoFocus: boolean }) {
  const check = checkPattern(d.pattern);
  // A new row starts empty without scolding; once typed in (or saved before), the error shows as you type.
  const error = check.ok || (d.saved === null && d.pattern === '') ? null : check.error;
  const errId = `trg-err-${d.id}`;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  return (
    <div className={`trg-rule ${d.enabled ? '' : 'is-off'} ${error ? 'is-invalid' : ''}`} role="group" aria-label={`Trigger ${d.pattern || d.saved || ''}`.trim()}>
      <div className="trg-main">
        <Toggle label={t.triggers.enabled(d.saved ?? d.pattern)} value={d.enabled} onChange={(v) => { onChange({ ...d, enabled: v }); onCommit(); }} />
        <span className="trg-field">
          <Icon name="bolt" size={13} stroke={1.9} />
          <input ref={input} className="mono" value={d.pattern} spellCheck={false} autoComplete="off" placeholder={t.triggers.placeholder}
            aria-label={t.triggers.pattern} aria-invalid={!!error} aria-describedby={error ? errId : undefined} maxLength={400}
            onChange={(e) => onChange({ ...d, pattern: e.target.value })}
            onBlur={onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
              // Esc: back to the saved pattern first; with nothing to undo, Settings closes as usual.
              if (e.key === 'Escape') {
                e.preventDefault();
                if (d.saved !== null && d.pattern !== d.saved) onChange({ ...d, pattern: d.saved });
                else useApp.getState().setSettingsOpen(null);
              }
            }} />
        </span>
        <button type="button" className="icon-btn trg-del" aria-label={t.triggers.remove(d.saved ?? d.pattern)} title={t.triggers.remove(d.saved ?? d.pattern)} onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {error && <div className="trg-error" id={errId} role="alert"><Icon name="info" size={12} />{error}</div>}
      <div className="trg-opts">
        <span className="trg-opt-label">{t.triggers.action}</span>
        <Segmented label={t.triggers.action} value={d.action} options={opts(t.triggers.actions)} onChange={(v) => { onChange({ ...d, action: v }); onCommit(); }} />
        <span className="trg-opt-label">{t.triggers.scope}</span>
        <Segmented label={t.triggers.scope} value={d.scope} options={opts(t.triggers.scopes)} onChange={(v) => { onChange({ ...d, scope: v }); onCommit(); }} />
      </div>
    </div>
  );
}

/** Settings › Terminal › Triggers: add, edit, toggle and delete rules; each change saves at once. */
export function TriggersEditor({ rules }: { rules: TriggerRule[] }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => rules.map(toDraft));
  const [focusId, setFocusId] = useState<string | null>(null);
  const latest = useRef(drafts);
  latest.current = drafts;
  const sent = useRef(JSON.stringify(rules));
  const list = useRef<HTMLDivElement>(null);

  // Changed elsewhere (another window, Restore Defaults): start over from the settings.
  useEffect(() => {
    const key = JSON.stringify(rules);
    if (key === sent.current) return;
    sent.current = key;
    setDrafts(rules.map(toDraft));
  }, [rules]);

  const save = (next: Draft[]) => {
    const valid = toRules(next);
    const key = JSON.stringify(valid);
    // What is valid now is what main has: saved patterns follow.
    const synced = next.map((d) => (checkPattern(d.pattern).ok ? { ...d, saved: d.pattern } : d));
    latest.current = synced;
    setDrafts(synced);
    if (key === sent.current) return;
    sent.current = key;
    void window.atelier.settings.set({ triggers: valid });
  };
  const change = (d: Draft) => { const next = latest.current.map((x) => (x.id === d.id ? d : x)); latest.current = next; setDrafts(next); };
  // Toggles and segments commit right away; the pattern on Enter and when the field is left.
  const commit = () => queueMicrotask(() => save(latest.current));
  const add = () => {
    const d: Draft = { id: newId(), pattern: '', saved: null, action: 'notify', scope: 'all', enabled: true };
    const next = [...latest.current, d];
    latest.current = next;
    setDrafts(next);
    setFocusId(d.id);
  };
  const remove = (id: string) => {
    const i = latest.current.findIndex((x) => x.id === id);
    save(latest.current.filter((x) => x.id !== id));
    // The keyboard stays in the list: the next row's delete button, or Add.
    requestAnimationFrame(() => {
      const dels = [...(list.current?.querySelectorAll<HTMLElement>('.trg-del') ?? [])];
      (dels[Math.min(i, dels.length - 1)] ?? list.current?.parentElement?.querySelector<HTMLElement>('.trg-add'))?.focus();
    });
  };

  return (
    <section className="trg-section" aria-label={t.triggers.title}>
      <div className="set-group-title">{t.triggers.title}</div>
      <p className="set-hint trg-hint">{t.triggers.hint}</p>
      <div className="trg-list" ref={list}>
        {drafts.length === 0 && <p className="trg-empty"><Icon name="bolt" size={16} />{t.triggers.empty}</p>}
        {drafts.map((d) => <Rule key={d.id} d={d} autoFocus={d.id === focusId} onChange={change} onCommit={commit} onRemove={() => remove(d.id)} />)}
      </div>
      <button type="button" className="btn-ghost trg-add" disabled={drafts.length >= MAX_TRIGGERS} onClick={add}><Icon name="plus" size={13} />{t.triggers.add}</button>
    </section>
  );
}
