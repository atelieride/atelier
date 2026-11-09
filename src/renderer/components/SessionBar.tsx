import { Suspense, lazy, memo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import type { SessionInfo } from '@shared/session';
import { SessionGlyph } from './SessionTile';
import { RenameInput } from './RenameInput';
import { ContextRing } from './ContextRing';
import { showContext } from '../ring';
import { limitLine, shownState } from '../selectors';
import { isLimitPaused } from '@shared/session-view';
import { reasonLabel } from '@shared/notifications';
import { useDayTurn } from '../minute';
import { PlanBadge, ScheduledChip, WorkChip } from './StateChips';
import { PromptChip } from './PromptChip';
import { RestartChip } from './RestartChip';
import { openScheduleSheet } from '../schedules';
import { PortChips } from './PortChips';
import { PrChip } from './PrChip';
import { TaskChip } from './TaskChip';
import { PopoutProject, paneMenuAt } from './PaneHeader';
import { Icon } from './Icon';
import { AskButton } from './companion/AskButton';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { keepPaneKeyboard } from '../pane-focus';
import { commitRename, nameTip, titleTip } from '../names';
import { toggleDictation } from '../dictation/controller';
import { kbd } from '../kbd';

// The model chip's popover loads when it first opens (the live demo's first paint had no room left for the Context
// tile).
const SessionPanel = lazy(() => import('./SessionPanel').then((m) => ({ default: m.SessionPanel })));

const SHORTCUT_LABEL = { 'alt-space': '⌥Space', 'ctrl-alt-space': '⌃⌥Space', f5: 'F5' } as const;

/** In the split view the bar sits under its pane's strip: which pane, whether it is focused, its grid cell. */
export interface PaneSlot { index: number; focused: boolean; style: CSSProperties }

/**
 * Above the terminal of a Claude session: what it is doing, how much context it has used. Without a session it is a
 * starting one's (launched, Claude not started yet: starting.ts) — "Starting…" — and this very element becomes the
 * session's bar when it arrives (the terminal keeps its size, nothing fades in again). In a pop-out
 * it sits in the window's bar. No state chip, phone, Changes or close button (2026-10-26: the row, the tab bar and the
 * menus have them); the state shows in the row, the tab's avatar and the terminal's frame.
 *
 * Who it is (avatar and name, a click on the name renames it) only where nothing else says it: a pop-out's bar. Above a
 * terminal — one pane, or a split pane under its own strip — the tab right above has both,
 * and the sidebar row too (2026-11-01).
 */
function SessionBarImpl({ term, pane, popout }: { term: TerminalInfo; pane?: PaneSlot; popout?: boolean }) {
  const s = term.session;
  const named = !!popout;
  // A click on the name, the Session panel, or Rename from a pane header's menu.
  const [editingHere, setEditing] = useState(false);
  const asked = useApp((st) => st.renaming?.id === term.id && st.renaming.at === 'bar');
  const editing = editingHere || asked;
  const bar = useRef<HTMLDivElement>(null);
  const stop = () => { setEditing(false); if (asked) useApp.getState().setRenaming(null); };
  const commit = (v: string) => { stop(); commitRename(term, v); };
  const state = shownState(term);
  // What it is doing; with states2 an error in words (raw code in the tooltip) and the compaction; a usage-limit pause as
  // the row says it. While Claude starts, "Starting…" takes its place.
  // Restart Session: "Restarting…" from the `/exit` until the session is back, with the new
  // MCP servers it loads.
  const restarting = useApp((st) => st.restarts[term.id]?.armed === false);
  const loading = useApp((st) => st.mcpAdded[term.id]);
  const today = useDayTurn(isLimitPaused(s));
  const limit = s && !s.compacting ? limitLine(s, today) : null;
  const activity = restarting ? (loading?.length ? `${t.restart.restarting} ${t.restart.loading(loading)}` : t.restart.restarting) : !s ? t.starting : s.compacting ? t.wait.compacting : limit ? limit.text : s.state === 'error' && s.errorReason ? reasonLabel(s.errorReason) : s.activity ?? '';
  const activityTip = !s ? t.startingTip : limit ? limit.tip : !s.compacting && s.state === 'error' && s.errorReason ? t.wait.errorTip(s.errorReason) : undefined;
  return (
    <div ref={bar} className={`session-bar ${s ? `state-${state}` : 'is-starting'}${pane ? ` is-pane${pane.focused ? ' is-focused' : ''}` : ''}${popout ? ' is-popout' : ''}`} style={pane?.style}
      aria-current={pane?.focused || undefined} onMouseDown={pane || popout ? keepPaneKeyboard : undefined} onContextMenu={pane ? paneMenuAt(pane.index) : undefined}>
      {named && <SessionGlyph term={term} state={state} size={20} />}
      {named && (editing ? (
        <RenameInput value={term.title} onCommit={commit} onCancel={stop} />
      ) : (
        <button type="button" className={`sb-title${term.nameSync ? ` name-${term.nameSync}` : ''}`} onClick={() => setEditing(true)} data-tip={nameTip(term.title, titleTip(term))}>{term.title}</button>
      ))}
      {/* The task it was started from, from the launch on: also while Claude starts. */}
      <TaskChip id={term.id} />
      {s && <PlanBadge session={s} />}
      <WorkChip term={term} side="below" />
      <ScheduledChip term={term} side="below" />
      <PromptChip terminalId={term.id} side="below" />
      <RestartChip terminalId={term.id} side="below" />
      <span className="sb-activity" data-tip={activityTip}>{activity}</span>
      {popout && <PopoutProject />}
      {/* While Claude starts there is nothing to dictate into or schedule yet. */}
      {/* The Session panel's Rename: in the bar's name where it has one, otherwise in the tab right above. */}
      {s && <SessionTools term={term} s={s} bar={bar} onRename={named ? () => setEditing(true) : () => useApp.getState().setRenaming({ id: term.id, at: 'tab' })} />}
    </div>
  );
}

/**
 * A running session's chips and buttons: ports, PR, the session chip (context and model; it opens the Session panel),
 * dictation, schedule, Ask.
 */
function SessionTools({ term, s, bar, onRename }: { term: TerminalInfo; s: SessionInfo; bar: RefObject<HTMLDivElement | null>; onRename: () => void }) {
  const panelOpen = useApp((st) => st.sessionPanel === term.id);
  const dictationOn = useApp((st) => st.settings.dictationEnabled);
  const listening = useApp((st) => st.dictation.phase === 'listening');
  const shortcutLabel = kbd(useApp((st) => SHORTCUT_LABEL[st.settings.dictationShortcut]));
  // Scheduled prompts: shown only when atelierd has them (with an older one the menus say why).
  const canSchedule = useApp((st) => !!st.daemon.schedulesAvailable);
  return (
    <>
      <PortChips id={term.id} />
      <PrChip id={term.id} />
      <button type="button" className={`sb-model ${panelOpen ? 'is-open' : ''}`} aria-haspopup="dialog" aria-expanded={panelOpen}
        aria-label={showContext(s.contextPct) ? `${s.model ?? t.panel.title} · ${t.contextUsed(s.contextPct)}` : s.model ?? t.panel.title}
        data-tip={panelOpen ? undefined : showContext(s.contextPct) ? `${t.contextUsed(s.contextPct)} · ${t.panel.chipTip}` : t.panel.chipTip}
        onClick={() => useApp.getState().setSessionPanel(panelOpen ? null : term.id)}>
        {showContext(s.contextPct) && <><ContextRing pct={s.contextPct} bare /><span className="sb-model-dot" aria-hidden="true">·</span></>}
        {/* A sliver of a pane: with no ring to keep, the chip folds to this (layout.css). */}
        <span className="sb-model-icon" aria-hidden="true"><Icon name="sliders" size={12} stroke={1.8} /></span>
        <span className="sb-model-name">{s.model ?? t.panel.title}</span>
        <Icon name="chevronDown" size={11} stroke={2} />
      </button>
      {panelOpen && bar.current && <Suspense fallback={null}><SessionPanel term={term} bar={bar.current} onRename={onRename} /></Suspense>}
      <span className="sb-sep" aria-hidden="true" />
      {dictationOn && (
        <button type="button" className={`sb-btn icon sb-mic ${listening ? 'is-dictating' : ''}`} aria-label={t.dictate} data-tip={t.dictateTip(shortcutLabel)} onClick={toggleDictation}>
          <Icon name="mic" size={13} stroke={1.8} />
        </button>
      )}
      {canSchedule && (
        <button type="button" className="sb-btn icon sb-schedule" aria-label={t.sched.action} data-tip={`${t.sched.action}  ${kbd('⌘⌥↵')}`} onClick={() => openScheduleSheet(term.id)}>
          <Icon name="sendLater" size={14} stroke={1.8} />
        </button>
      )}
      {/* Ask: its own store reads, so the bar's memo comparison stays the term's. */}
      <AskButton term={term} />
    </>
  );
}

export const SessionBar = memo(SessionBarImpl, (a, b) => JSON.stringify(a.term) === JSON.stringify(b.term) && a.popout === b.popout && a.pane?.index === b.pane?.index && a.pane?.focused === b.pane?.focused);
