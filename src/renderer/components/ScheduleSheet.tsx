import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { MAX_TEXT, cleanPromptText, minuteOf, type IfBusy } from '@shared/scheduled-prompts';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { Icon } from './Icon';
import { Avatar } from './Avatar';
import { shownState } from '../selectors';
import { clockOf, composeAt, dayOf, parseClock, presetsFor, railFor, resetAtFor, stepClock, summaryOf, timeError } from '../schedule-view';
import { deleteSchedule, fireSchedule, reportResult, usageOf } from '../schedules';

type Day = 0 | 1 | 'date';

/** A local `YYYY-MM-DD` for the date input. */
const isoDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fromIso = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null; };

/**
 * The composer: a centered top sheet, like New Session. The prompt, when (presets, a day
 * and a time, the session's next 24 h on a rail), what to do if Claude is busy. ⌘↵ schedules, Esc closes.
 */
export function ScheduleSheet() {
  const sheet = useApp((s) => s.scheduleSheet)!;
  const term = useApp((s) => s.terminals.find((x) => x.id === sheet.terminalId));
  const list = useApp((s) => s.schedules);
  const usageList = useApp((s) => s.usage);
  const editing = useMemo(() => (sheet.editId ? list.find((x) => x.id === sheet.editId) : undefined), [sheet.editId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now());
  const [text, setText] = useState(editing?.text ?? sheet.text ?? '');
  const [day, setDay] = useState<Day>(() => (editing ? (dayOf(editing.at, 0) === dayOf(Date.now(), 0) ? 0 : dayOf(editing.at, 0) === dayOf(Date.now(), 1) ? 1 : 'date') : 0));
  const [date, setDate] = useState(() => isoDay(editing?.at ?? Date.now()));
  const [clock, setClock] = useState(editing ? clockOf(editing.at) : '');
  const [ifBusy, setIfBusy] = useState<IfBusy>(editing?.ifBusy ?? 'wait');
  const [busy, setBusyFlag] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const close = () => useApp.getState().setScheduleSheet(null);
  useEffect(() => { const el = area.current; if (!el) return; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id); }, []);
  // The session left (closed) or its prompt went (deleted, or sent or skipped meanwhile): nothing left to edit.
  useEffect(() => {
    const live = sheet.editId ? list.find((x) => x.id === sheet.editId) : undefined;
    if (!term || (sheet.editId && (!live || live.status === 'sent' || live.status === 'skipped'))) close();
  }, [term, list]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!term) return null;

  const usage = usageOf(term, usageList);
  const resetAt = resetAtFor(usage, now);
  const exceptId = editing?.id;
  const baseDay = day === 'date' ? fromIso(date) ?? dayOf(now, 0) : dayOf(now, day);
  const bad = clock.trim() !== '' && !parseClock(clock);
  const at = clock.trim() ? composeAt(baseDay, clock) : null;
  const err = at !== null ? timeError(list, term.id, at, now, exceptId) : null;
  const clean = cleanPromptText(text);
  const can = !busy && clean.trim().length > 0 && at !== null && !err;
  const presets = presetsFor(list, term.id, now, usage, exceptId);
  const showPresets = !editing || clock.trim() === '';
  const rail = railFor(list, term.id, now, { at, clash: err?.kind === 'taken', resetAt, exceptId });

  const pickAt = (ms: number) => {
    setClock(clockOf(ms));
    const d = dayOf(ms, 0);
    if (d === dayOf(now, 0)) setDay(0);
    else if (d === dayOf(now, 1)) setDay(1);
    else { setDay('date'); setDate(isoDay(ms)); }
  };
  const submit = async () => {
    if (!can || at === null) return;
    setBusyFlag(true);
    const r = editing
      ? await window.atelier.schedules.update({ id: editing.id, text: clean, at, ifBusy }).catch(() => ({ ok: false as const, error: 'fallback' }))
      : await window.atelier.schedules.add({ terminalId: term.id, text: clean, at, ifBusy }).catch(() => ({ ok: false as const, error: 'fallback' }));
    setBusyFlag(false);
    if (!reportResult(r)) return;
    close();
    const when = summaryOf(at, Date.now()).replace(/^Sends /, '').replace(/ · .*$/, '');
    useApp.getState().showToast(editing ? t.sched.savedFor(when) : t.sched.scheduledFor(when), undefined, 'info');
  };
  // A click on the sheet's own text or padding keeps the keyboard where it was (in the sheet): Esc and ⌘↵ still work.
  const keepFocus = (e: MouseEvent) => {
    e.stopPropagation();
    if (!(e.target as Element).closest('input, textarea, button, select, [tabindex]')) e.preventDefault();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
  };
  const summary = at === null || err || bad ? (clean.trim() ? t.sched.pickWhen : t.sched.writeFirst) : summaryOf(at, now);
  const fixLabel = err?.kind === 'taken' ? t.sched.useTime(clockOf(err.fix)) : err?.kind === 'past' ? t.sched.tomorrowAt(clockOf(err.fix)) : '';

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette sp-sheet" role="dialog" aria-label={editing ? t.sched.editTitle : t.sched.title} onMouseDown={keepFocus} onKeyDown={onKey}>
        <div className="sp-head">
          <span className="sp-glyph"><Icon name={editing ? 'edit' : 'sendLater'} size={15} stroke={1.9} /></span>
          <span className="sp-title">{editing ? t.sched.editTitle : t.sched.title}</span>
          <span className="sp-grow" />
          <span className="sp-to">{t.sched.to}</span>
          <span className="sp-target" data-tip={term.title}>
            <Avatar title={term.title} color={term.color} state={shownState(term)} size={18} />
            <span className="sp-target-name">{term.title}</span>
          </span>
        </div>
        <div className="sp-field">
          <textarea ref={area} className="sp-text" aria-label={t.sched.placeholder} placeholder={t.sched.placeholder} rows={4} maxLength={MAX_TEXT}
            value={text} onChange={(e) => setText(e.target.value)} />
          <div className="sp-field-foot"><span className="mono">{kbd('⇧↵')}</span> {t.sched.newLine}<span className="sp-grow" />{editing ? null : t.sched.hint}</div>
        </div>
        <div className="sp-when">
          <span className="section-label">{t.sched.when}</span>
          {showPresets && (
            <div className="sp-presets">
              {presets.map((p) => {
                const on = at !== null && minuteOf(at) === p.at && !err;
                return (
                  <button key={p.key} type="button" className={`sp-preset${on ? ' is-on' : ''}${p.key === 'reset' ? ' is-reset' : ''}${p.taken ? ' is-taken' : ''}`}
                    data-tip={p.taken ? t.sched.presetTaken(clockOf(p.at)) : p.key === 'reset' ? t.sched.resetTip : undefined}
                    onClick={() => pickAt(p.at)}>
                    {p.key === 'reset' && <Icon name="pulse" size={12} stroke={1.9} />}
                    {p.label}<span className="sp-preset-time mono">{p.day ? `${p.day} ` : ''}{clockOf(p.at)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="sp-pick">
            <div className="sp-seg" role="radiogroup" aria-label={t.sched.day}>
              {([[0, t.sched.today], [1, t.sched.tomorrow], ['date', t.sched.date]] as [Day, string][]).map(([v, label]) => (
                <button key={String(v)} type="button" role="radio" aria-checked={day === v} className={`sp-seg-opt${day === v ? ' is-on' : ''}`} onClick={() => setDay(v)}>{label}</button>
              ))}
            </div>
            {day === 'date' && <input type="date" className="sp-date mono" aria-label={t.sched.pickDate} value={date} min={isoDay(now)} onChange={(e) => setDate(e.target.value)} />}
            <span className="sp-at">{t.sched.at}</span>
            <input className={`sp-time mono${bad || err ? ' is-bad' : ''}`} aria-label={t.sched.time} placeholder="--:--" maxLength={5} value={clock}
              aria-invalid={bad || !!err || undefined}
              onChange={(e) => setClock(e.target.value.replace(/[^0-9:]/g, '').slice(0, 5))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setClock(stepClock(clock, e.key === 'ArrowUp' ? 1 : -1)); }
              }} />
            <span className="sp-grow" />
            <span className={`sp-summary${at !== null && !err && !bad ? ' is-ok' : ''}`} aria-live="polite">{summary}</span>
          </div>
          <div className="sp-rail" aria-hidden="true">
            <span className="sp-rail-line" />
            {rail.ticks.map((k, i) => <span key={i} className="sp-rail-tick mono" style={{ left: `${k.left}%` }}>{k.label}</span>)}
            {rail.reset !== null && <span className="sp-rail-reset" style={{ left: `${rail.reset}%` }} data-tip={t.sched.resetTip} />}
            {rail.dots.map((d, i) => <span key={i} className={`sp-rail-dot is-${d.kind}${d.clash ? ' is-clash' : ''}`} style={{ left: `${d.left}%` }} data-tip={d.tip} />)}
          </div>
          {(bad || err) && (
            <div className="sp-error" role="alert">
              <Icon name="warning" size={13} stroke={1.9} />
              <span className="sp-error-text">{bad ? t.sched.badTime : err!.kind === 'past' ? t.sched.past : t.sched.taken(clockOf(at!), err!.kind === 'taken' ? err!.by.text.slice(0, 48) : '')}</span>
              {err && <button type="button" className="sp-fix" onClick={() => pickAt(err.fix)}>{fixLabel}</button>}
            </div>
          )}
        </div>
        <div className="sp-busy" role="radiogroup" aria-label={t.sched.ifBusy}>
          <span className="sp-busy-label">{t.sched.ifBusy}</span>
          {([['wait', t.sched.wait], ['skip', t.sched.skip]] as [IfBusy, string][]).map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={ifBusy === v} className={`sp-radio${ifBusy === v ? ' is-on' : ''}`} onClick={() => setIfBusy(v)}><i />{label}</button>
          ))}
        </div>
        <div className="sp-foot">
          {editing && <button type="button" className="sp-delete" onClick={() => { close(); void deleteSchedule(editing); }}>{t.sched.delete}</button>}
          {editing && <button type="button" className="sp-send-now" onClick={() => { close(); void fireSchedule(editing.id); }}>{t.sched.sendNow}</button>}
          <span className="sp-grow" />
          <button type="button" className="btn-ghost" onClick={close}>{t.sched.cancel} <span className="mono sp-kbd">esc</span></button>
          <button type="button" className="btn-primary" disabled={!can} onClick={() => void submit()}>
            {editing ? t.sched.save : t.sched.schedule} <span className="mono sp-kbd is-on-brand">{kbd('⌘↵')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
