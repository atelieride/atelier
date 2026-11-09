import type { SessionInfo } from '@shared/session';
import { modeBadge } from '@shared/session-view';
import type { ReactNode } from 'react';
import { t } from '../i18n/en';
import type { TerminalInfo } from '@shared/protocol';
import { useApp } from '../store';
import { scheduledView, workChipView } from '../work-view';
import { Icon } from './Icon';
import { BG_GLYPH, rememberBgOpener } from './bg-shared';
import { bgChipOpen } from '../background-view';

// v2.0 chips, from an atelierd with states2; without it the fields are missing and nothing is shown.

/** The small "plan" badge while Claude Code is in plan mode; a bare rose "B" when it bypasses permissions. */
export function PlanBadge({ session }: { session: SessionInfo }) {
  const badge = modeBadge(session.permissionMode);
  if (badge === 'bypass') return <span className="plan-badge is-bypass" role="img" aria-label={t.wait.bypassLabel} data-tip={t.wait.bypassTip}>{t.wait.bypass}</span>;
  if (!badge) return null;
  // On a crowded narrow line it becomes a bare "P" like the bypass mark (layout.css draws it: the text stays "plan"),
  // read as what it is in either form.
  return <span className="plan-badge" role="img" aria-label={t.wait.planLabel} data-tip={t.wait.planTip} data-short={t.wait.planShort}><span className="plan-full">{t.wait.plan}</span></span>;
}

// Simple marks that read at 10 px: Claude's sparkle for agents, a prompt for shells, an eye for monitors.

/**
 * What runs in the background: "1 agent · 2 shells", a thin outline with the working dot, dimmed when only capped
 * shells remain. Three renderings, picked by the row's container
 * queries: in full, the numbers with small glyphs, the total alone; the tooltip always lists everything.
 */
export function WorkChip({ term, side }: { term: TerminalInfo; side: 'below' | 'right' }) {
  const v = workChipView(term, Date.now());
  const chip = useBgChip(term.id, side, 'all');
  if (!v) return null;
  return (
    <ChipTag side={side} chip={chip} className={`work-chip${v.counting ? ' is-counting' : ''}${v.idle ? ' is-idle' : ''}${v.long ? ' is-long' : ''}`} tip={`${v.tip}\n${t.bg.chipTip}`}>
      <i className="work-dot" aria-hidden />
      <span className="work-full">{v.full}</span>
      <span className="work-short">
        {v.parts.map(([kind, n]) => (
          <span key={kind} className="work-part">
            <Icon name={BG_GLYPH[kind]} size={10} stroke={2} /><span>{n}</span>
          </span>
        ))}
      </span>
      <span className="work-total">{v.total}</span>
    </ChipTag>
  );
}

/** Scheduled wake-ups (/loop, cron): a clock and the soonest local time; icon only when no time can be computed. */
export function ScheduledChip({ term, side }: { term: TerminalInfo; side: 'below' | 'right' }) {
  const v = scheduledView(term.work, Date.now(), term.session);
  const chip = useBgChip(term.id, side, 'scheduled');
  if (!v) return null;
  return (
    <ChipTag side={side} chip={chip} className={`sched-chip${v.time ? '' : ' is-bare'}${v.loop ? ' is-loop' : ''}`} tip={`${v.tip}\n${t.bg.chipTip}`}>
      <Icon name={v.loop ? 'sync' : 'clock'} size={11} stroke={1.9} />
      {v.time && <span className="sched-time mono">{v.time}</span>}
    </ChipTag>
  );
}

type Chip = { open: boolean; toggle: (el: HTMLElement) => void };

/** Open state and toggle of a chip's Background popover. */
function useBgChip(terminalId: string, side: 'below' | 'right', section: 'all' | 'scheduled'): Chip {
  const open = useApp((s) => bgChipOpen(s.bgPopover, terminalId, side, section));
  const toggle = (el: HTMLElement) => {
    const st = useApp.getState();
    if (open) { st.closeBgPopover(); return; }
    rememberBgOpener(el);
    // In the sidebar the popover sits beside the whole row, not the small chip.
    const a = (side === 'right' ? (el.closest('.session-row') ?? el) : el).getBoundingClientRect();
    st.openBgPopover({ terminalId, anchor: { left: a.left, top: a.top, right: a.right, bottom: a.bottom }, side, section });
  };
  return { open, toggle };
}

/**
 * The chip itself: a button in the session bar. In the sidebar it sits inside the row's own button (a button never
 * sits in a button, and nothing interactive goes inside one): a plain span, a mouse-only click target that neither
 * selects the row nor starts a drag; the keyboard goes through the row's "Show Background" menu item.
 */
function ChipTag({ side, chip, className, tip, children }: { side: 'below' | 'right'; chip: Chip; className: string; tip: string; children: ReactNode }) {
  const cls = `${className}${chip.open ? ' is-open' : ''}`;
  if (side === 'below') {
    return <button type="button" className={cls} aria-haspopup="dialog" aria-expanded={chip.open} data-tip={tip} onClick={(e) => { e.stopPropagation(); chip.toggle(e.currentTarget); }}>{children}</button>;
  }
  return (
    <span className={cls} data-tip={tip}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); chip.toggle(e.currentTarget); }}
      onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}
