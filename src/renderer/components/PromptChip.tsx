import { useApp } from '../store';
import { chipView } from '../schedule-view';
import { t } from '../i18n/en';
import { Icon } from './Icon';
import { rememberScheduleOpener } from './SchedulePopover';

/**
 * A session's scheduled prompts: the send-clock and the next time, "+N" for the others;
 * its clock amber when one was missed, sky while one is due and waits, pink when a usage limit moved it. A button in the
 * session bar; in the sidebar row (inside the row's own button) a plain span with a mouse-only click, like the
 * Background chips — the keyboard goes through the row's "Scheduled Prompts" menu item.
 */
export function PromptChip({ terminalId, side }: { terminalId: string; side: 'below' | 'right' }) {
  const list = useApp((s) => s.schedules);
  const v = chipView(list, terminalId, Date.now());
  const open = useApp((s) => s.schedulePopover?.terminalId === terminalId && s.schedulePopover.side === side);
  if (!v) return null;
  const toggle = (el: HTMLElement) => {
    const st = useApp.getState();
    if (open) { st.closeSchedulePopover(); return; }
    rememberScheduleOpener(el);
    const a = (side === 'right' ? (el.closest('.session-row') ?? el) : el).getBoundingClientRect();
    st.openSchedulePopover({ terminalId, anchor: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, side });
  };
  const cls = `sp-chip tone-${v.tone}${open ? ' is-open' : ''}`;
  const body = (
    <>
      <Icon name="sendLater" size={11} stroke={1.9} />
      <span className="sp-chip-time mono">{v.tone === 'missed' ? `${t.sched.missedChip} ${v.time}` : v.time}</span>
      {v.more > 0 && <span className="sp-chip-more mono">+{v.more}</span>}
    </>
  );
  if (side === 'below') {
    return <button type="button" className={cls} aria-haspopup="dialog" aria-expanded={open} aria-label={`${t.sched.list}: ${v.tip}`} data-tip={v.tip} onClick={(e) => { e.stopPropagation(); toggle(e.currentTarget); }}>{body}</button>;
  }
  return (
    <span className={cls} data-tip={v.tip}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); toggle(e.currentTarget); }}
      onDoubleClick={(e) => e.stopPropagation()}>
      {body}
    </span>
  );
}
