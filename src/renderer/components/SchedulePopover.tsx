import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ScheduledPrompt } from '@shared/scheduled-prompts';
import { placePopover } from '../popover-place';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { kbd } from '../kbd';
import { Icon } from './Icon';
import { clockOf, dayLabel, rowsFor, statusLine } from '../schedule-view';
import { copySchedule, deleteSchedule, editSchedule, fireSchedule, openScheduleSheet } from '../schedules';
import { focusableFor, scrollClosesPopover } from './bg-shared';

const WIDTH = 400;

// What opened the popover (its chip, or the row whose menu did): Escape gives the focus back to it.
let opener: HTMLElement | null = null;
export function rememberScheduleOpener(el: HTMLElement | null) { opener = el; }

/**
 * A session's scheduled prompts, from its chip or its row's menu: sorted by time, each
 * with Send Now, Edit… and Delete (Undo in the toast); missed ones with Send Now / Reschedule… / Delete; today's sent
 * ones folded at the end. ↑/↓ move, ↵ edits, ⌫ deletes, Esc closes.
 */
export function SchedulePopover() {
  const pop = useApp((s) => s.schedulePopover);
  const term = useApp((s) => (pop ? s.terminals.find((x) => x.id === pop.terminalId) : undefined));
  const list = useApp((s) => s.schedules);
  const [now, setNow] = useState(Date.now());
  const [doneOpen, setDoneOpen] = useState(false);
  const [view, setView] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!pop) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pop]);
  useEffect(() => { setDoneOpen(false); }, [pop]);
  useEffect(() => { if (pop && !term) useApp.getState().closeSchedulePopover(); }, [pop, term]);
  const rows = pop ? rowsFor(list, pop.terminalId, now) : { live: [], done: [] };
  const count = rows.live.length + (doneOpen ? rows.done.length : 0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!pop || !el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxHeight = '';
    el.style.width = `${Math.min(WIDTH, vw - 16)}px`;
    const p = placePopover(pop.anchor, pop.side, { width: WIDTH, height: el.scrollHeight }, { width: vw, height: vh });
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.width = `${p.width}px`;
    el.style.maxHeight = `${p.maxHeight}px`;
    el.style.visibility = 'visible';
  }, [pop, count, view]);
  useEffect(() => {
    if (!pop) return;
    (box.current?.querySelector<HTMLElement>('.spp-main') ?? box.current?.querySelector<HTMLElement>('.spp-new'))?.focus();
  }, [pop]);
  useEffect(() => {
    if (!pop) return;
    const resize = () => setView((n) => n + 1);
    const scroll = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      if (scrollClosesPopover(e.target, opener, e.target === document)) useApp.getState().closeSchedulePopover();
    };
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      // A toast's Undo (a delete made here) keeps it open: the prompt comes back into view.
      if (box.current && !box.current.contains(target) && !(opener && opener.contains(target)) && !(target as Element).closest?.('.ctx-menu, .toast')) useApp.getState().closeSchedulePopover();
    };
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('mousedown', down, true);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('scroll', scroll, true); window.removeEventListener('mousedown', down, true); };
  }, [pop]);
  if (!pop || !term) return null;
  const close = (back: boolean) => {
    useApp.getState().closeSchedulePopover();
    if (back && opener?.isConnected) focusableFor(opener)?.focus();
  };
  const act = (fn: () => void) => { close(false); fn(); };
  const onKey = (e: KeyboardEvent) => {
    const mains = [...(box.current?.querySelectorAll<HTMLElement>('.spp-main') ?? [])];
    const i = mains.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); mains[Math.min(mains.length - 1, i + 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mains[Math.max(0, i - 1)]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && i >= 0) {
      e.preventDefault();
      const p = list.find((x) => x.id === mains[i]!.dataset.id);
      if (p) { void deleteSchedule(p); (mains[i + 1] ?? mains[i - 1])?.focus(); }
    } else if (e.key === 'Tab') {
      const all = [...(box.current?.querySelectorAll<HTMLElement>('button') ?? [])];
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (all.length === 0) return;
      if (!e.shiftKey && at === all.length - 1) { e.preventDefault(); all[0]!.focus(); }
      else if (e.shiftKey && at <= 0) { e.preventDefault(); all[all.length - 1]!.focus(); }
    }
  };
  const menu = (e: React.MouseEvent, p: ScheduledPrompt) => useApp.getState().openMenu(e, [
    ...(p.status === 'sent' || p.status === 'skipped' ? [] : [
      { id: 'send-now', label: t.sched.sendNow, icon: 'send' as const, run: () => act(() => void fireSchedule(p.id)) },
      { id: 'edit', label: t.sched.edit, icon: 'edit' as const, run: () => act(() => editSchedule(p)) }
    ]),
    { id: 'copy', label: t.sched.copy, icon: 'copy' as const, run: () => copySchedule(p) },
    ...(p.status === 'sent' || p.status === 'skipped' ? [{ id: 'again', label: t.sched.again, icon: 'sendLater' as const, run: () => act(() => openScheduleSheet(p.terminalId, p.text)) }] : []),
    'sep' as const,
    { id: 'delete', label: t.sched.delete, icon: 'trash' as const, danger: true, run: () => void deleteSchedule(p) }
  ]);
  const row = (p: ScheduledPrompt, done: boolean) => {
    const moved = (p.reason === 'limit' || p.reason === 'limit-hit') && p.movedFrom !== undefined && p.status === 'pending';
    const tone = p.status === 'missed' ? 'missed' : moved ? 'moved' : p.status === 'armed' || p.dueSince !== undefined ? 'due' : done ? 'done' : 'next';
    return (
      <div key={p.id} className={`spp-row tone-${tone}`} role="listitem" onContextMenu={(e) => menu(e, p)}>
        <button type="button" className="spp-main" data-id={p.id} onClick={() => (done ? copySchedule(p) : act(() => editSchedule(p)))}
          aria-label={`${clockOf(p.at)} ${dayLabel(p.at, now)}: ${p.text.slice(0, 80)}`}>
          <span className="spp-when">
            <span className="spp-clock mono">{clockOf(p.at)}</span>
            <span className="spp-day">{dayLabel(p.at, now)}</span>
          </span>
          <span className="spp-body">
            <span className="spp-text">{p.text}</span>
            <span className="spp-status">{statusLine(p, now)}</span>
          </span>
        </button>
        <span className="spp-actions">
          {p.status === 'missed' ? (
            <>
              <button type="button" className="spp-btn is-primary" onClick={() => act(() => void fireSchedule(p.id))}>{t.sched.sendNow}</button>
              <button type="button" className="spp-btn" onClick={() => act(() => editSchedule(p))}>{t.sched.reschedule}</button>
            </>
          ) : moved ? (
            <button type="button" className="spp-btn" onClick={() => act(() => void fireSchedule(p.id, 'usage'))}>{t.sched.sendAnyway}</button>
          ) : !done && (
            <>
              <button type="button" className="spp-icon" aria-label={t.sched.sendNow} data-tip={t.sched.sendNow} onClick={() => act(() => void fireSchedule(p.id))}><Icon name="send" size={13} stroke={1.8} /></button>
              <button type="button" className="spp-icon" aria-label={t.sched.edit} data-tip={t.sched.edit} onClick={() => act(() => editSchedule(p))}><Icon name="edit" size={13} stroke={1.8} /></button>
            </>
          )}
          {done && <button type="button" className="spp-icon" aria-label={t.sched.again} data-tip={t.sched.again} onClick={() => act(() => openScheduleSheet(p.terminalId, p.text))}><Icon name="sendLater" size={13} stroke={1.8} /></button>}
          <button type="button" className="spp-icon is-danger" aria-label={t.sched.delete} data-tip={`${t.sched.delete}  ⌫`} onClick={() => void deleteSchedule(p)}><Icon name="trash" size={13} stroke={1.8} /></button>
        </span>
      </div>
    );
  };
  return createPortal(
    <div ref={box} className="sp-popover" role="dialog" aria-label={`${t.sched.list}: ${term.title}`} style={{ visibility: 'hidden' }} onKeyDown={onKey}>
      <div className="spp-head">
        <span className="spp-title">{t.sched.list}</span>
        <span className="spp-session">· {term.title}</span>
        <span className="sp-grow" />
        <button type="button" className="spp-new" onClick={() => act(() => openScheduleSheet(term.id))}><Icon name="plus" size={11} stroke={2.2} />{t.sched.action}</button>
      </div>
      <div className="spp-list" role="list">
        {rows.live.length === 0 && <div className="spp-empty">{t.sched.empty}</div>}
        {rows.live.map((p) => row(p, false))}
        {rows.done.length > 0 && (
          <>
            <button type="button" className="spp-fold" aria-expanded={doneOpen} onClick={() => setDoneOpen((v) => !v)}>
              <Icon name={doneOpen ? 'chevronDown' : 'chevron'} size={11} stroke={2} />{t.sched.sentToday}<span className="spp-count mono">{rows.done.length}</span>
            </button>
            {doneOpen && rows.done.map((p) => row(p, true))}
          </>
        )}
      </div>
      <div className="spp-foot">
        <span><span className="mono">↑↓</span> {t.sched.hintMove}</span><span><span className="mono">↵</span> {t.sched.hintEdit}</span><span><span className="mono">⌫</span> {t.sched.hintDelete}</span>
        <span className="sp-grow" />
        <button type="button" className="spp-all" onClick={() => act(() => useApp.getState().setPaletteOpen(true, 'scheduled:'))}>{t.sched.allSessions} <span className="mono">{kbd('⌘K')}</span></button>
      </div>
    </div>,
    document.body
  );
}
