import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxSection } from '../inbox';
import type { TerminalInfo } from '@shared/protocol';
import { Avatar } from './Avatar';
import { runOf } from '../automations/view';
import { RenameInput } from './RenameInput';
import { Icon } from './Icon';
import { PinButton } from './PinButton';
import { CwdChip } from './CwdChip';
import { ProfileChip } from './ProfileChip';
import { AccountChip } from './AccountChip';
import { PortChips } from './PortChips';
import { t } from '../i18n/en';
import { commitRename, nameTip } from '../names';
import { enterClass } from '../seen';
import { useApp } from '../store';
import { sessionRowMenu } from '../menus';
import { sessionSubtitle, shownState } from '../selectors';
import { isPending } from '../comments';
import { PlanBadge, ScheduledChip, WorkChip } from './StateChips';
import { PromptChip } from './PromptChip';
import { isLimitPaused, isWaiting } from '@shared/session-view';
import { lastMessageLine } from '../last-message';
import { useAgo, useDayTurn } from '../minute';
import { closeFromRow, useRowLeave } from '../confirms/RowConfirm';
import { onEscCancel } from '../confirms/InlineConfirm';
import { RestartChip } from './RestartChip';
import { RemoteChip } from './RemoteChip';
import { RowRestartConfirm } from './RowRestartConfirm';
import { askMarked } from '../companion/attention';
import { openAskFor, shownTerminals } from '../companion/actions';
import { useRowClick, useRowDrag } from './WorkspaceGroup';
import { bandAttr, sameBand, type Band } from '../row-order';
import { useReorder } from '../reorder-drag';

/**
 * section: the row's section in the grouped list; when it changes, the row enters its new place with the motion.
 * Without a session the row is a starting one (launched, Claude not started yet: starting.ts): same row, same place,
 * "Starting…" under the name; when the session arrives this very element carries on.
 */
/** In a window of its own: a small window glyph after the name; a click on the row brings it forward. */
export function PoppedMarker() {
  return <span className="row-popout" role="img" aria-label={t.popout.inWindow} data-tip={t.popout.inWindow}><Icon name="window" size={12} stroke={1.8} /></span>;
}

/** The names on a row's third line (account, folder, profile). */
const WHO_TEXT = '.session-details :is(.chip-text, .cwd-chip > bdi, .cwd-wt-name)';

/** A label cut down to a stub: under about five characters of room left for it. */
function isStub(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 0.5 && el.clientWidth < 36;
}

/**
 * A name on the third line that would be cut to a stub ("C…") marks the row data-who-short: its account, folder and
 * profile show their glyphs alone (the tooltips keep the names). Decided in the full form each time (attribute off,
 * measured, back on, before paint), so one width never flips between the two.
 */
function useWhoFit(row: RefObject<HTMLElement | null>): void {
  const check = useRef(() => {});
  check.current = () => {
    const el = row.current;
    if (!el) return;
    el.removeAttribute('data-who-short');
    if ([...el.querySelectorAll<HTMLElement>(WHO_TEXT)].some(isStub)) el.setAttribute('data-who-short', '');
  };
  useLayoutEffect(() => check.current());
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    // The row's width changes (the sidebar resized): the attribute changes no width of the row, so this never loops.
    const ro = new ResizeObserver(() => check.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [row]);
}

/**
 * The name alone on the first line. The second holds what changes during the turn: the activity (or when the last
 * message was), then mode, background work, wake-ups, scheduled prompts, restart and Remote Control, the ports at its
 * end; it is always there, so nothing that comes and goes there changes the row's height. A third line, only for a
 * session that runs as another account, in another folder or with a profile, says so: those don't change while it runs.
 * `account`: the account its group's head says every session there runs as (sharedAccount), not said again on the row.
 */
function SessionRowImpl({ term, selected, pinned, popped = false, onSelect, section, band, account }: { term: TerminalInfo; selected: boolean; pinned: boolean; popped?: boolean; onSelect: (id: string) => void; section?: InboxSection; band?: Band; account?: string }) {
  const s = term.session;
  // Double-click, or Rename from the row's menu (the field where it was asked).
  const [editingHere, setEditing] = useState(false);
  const asked = useApp((st) => st.renaming?.id === term.id && st.renaming.at === 'row');
  const editing = editingHere || asked;
  // Decided at mount (a re-render mid-animation must not remove it), and again when the row changes section.
  const [enter, setEnter] = useState(() => enterClass(term.id));
  const rowEl = useRef<HTMLDivElement>(null);
  const lastSection = useRef(section);
  useLayoutEffect(() => {
    const was = lastSection.current;
    lastSection.current = section;
    if (was === section || was === undefined || section === undefined) return;
    setEnter('enter');
    // Already carrying the class: play the entrance again.
    for (const a of rowEl.current?.getAnimations() ?? []) if ((a as CSSAnimation).animationName === 'atl-enter') { a.cancel(); a.play(); }
  }, [section]);
  const strong = selected || !!s?.unread || isWaiting(s);
  // "Pending review": comments written for this session and not sent yet.
  const pending = useApp((st) => st.comments.reduce((n, c) => n + (isPending(c, term.id) ? 1 : 0), 0));
  const state = shownState(term);
  // Its close sent: "Closing…" until atelierd drops it (seconds on Windows), and nothing closes it again.
  const shutting = useApp((st) => !!st.closing[term.id]);
  // Restart Session: "Restarting…" from the `/exit` until the session is back.
  const restarting = useApp((st) => st.restarts[term.id]?.armed === false);
  // Paused at a usage limit: "continues tomorrow at 01:30" becomes "continues at 01:30" at midnight.
  const today = useDayTurn(isLimitPaused(s));
  const subtitle = shutting ? { text: t.closingRow, tip: null } : restarting ? { text: t.restart.restarting, tip: null } : s ? sessionSubtitle(s, t.stateLabel, undefined, term.work, today) : { text: t.starting, tip: null };
  const hasPorts = useApp((st) => st.settings.showPorts && (st.ports[term.id]?.length ?? 0) > 0);
  // Nothing going on: when the last message was ("28m ago"), re-rendered when the label changes.
  const now = useAgo(subtitle === null && s && (s.state === 'done' || s.state === 'idle') ? s.lastMessageAt ?? null : null);
  // The second line: what Claude is doing, or with nothing going on, when the last message was.
  const last = s && subtitle === null ? lastMessageLine(s, now) : null;
  // Started by an automation: the avatar's mark.
  const automated = useApp((st) => runOf(st.automations, term.id) !== null);
  // Its close asked here: a bubble beside the row asks (confirms/CloseHost.tsx); the row keeps its form, marked.
  const closing = useApp((st) => st.closeAsk?.id === term.id && st.closeAsk.at === 'row');
  // Its restart asked here: the same way.
  const restartAsked = useApp((st) => st.restartAsk?.id === term.id && st.restartAsk.at === 'row');
  // Ask answered while its panel was closed or off screen: a violet mark, until opened.
  const askMark = useApp((st) => {
    const unseen = !!s && !!st.askThreads[s.sessionId]?.unseen;
    return unseen && askMarked({ unseen, open: !!st.askOpen[term.id], shown: shownTerminals(st).has(term.id) });
  });
  // Session avatars off: the title starts the row; the automation
  // mark and the pin move to the end of the title line.
  const avatars = useApp((st) => st.settings.sessionAvatars);
  // 22 px like a terminal row's icon: sessions and terminals line up in one column of icons.
  const lead = avatars ? <Avatar title={term.title} color={term.color} state={state} pinned={pinned} auto={automated} size={22} /> : null;
  const stop = () => { setEditing(false); if (asked) useApp.getState().setRenaming(null); };
  const commit = (v: string) => { stop(); commitRename(term, v); };
  const inner = (
    <>
      {lead}
      <span className="session-main">
        {editing ? (
          <RenameInput value={term.title} onCommit={commit} onCancel={stop} />
        ) : (
          <span className="session-line">
            <span className={`session-title ${strong ? 'is-strong' : ''}`}>{term.title}</span>
            {popped && <PoppedMarker />}
          </span>
        )}
        {/* What changes during the turn, always one line and always there (empty or not), so what comes and goes on it
            never changes the row's height: the rows under it never move by themselves. It runs under the row's buttons
            too. The activity gives way first; the ports (buttons, so outside this button: .row-ports) sit at its right
            end, in their measured room. */}
        <span className="session-sub">
          {subtitle !== null && <span className="session-activity" data-tip={subtitle.tip ?? undefined}>{subtitle.text}</span>}
          {last && <span className="session-activity is-time mono" data-tip={last.tip}>{last.text}</span>}
          {s && <PlanBadge session={s} />}
          <WorkChip term={term} side="right" />
          <ScheduledChip term={term} side="right" />
          <PromptChip terminalId={term.id} side="right" />
          <RestartChip terminalId={term.id} side="right" />
          <RemoteChip term={term} kind="inline" />
        </span>
        {/* What the session runs as, where, with which profile: fixed while it runs, so its line never comes and goes
            during a turn. layout.css hides it while empty (the default account, the project's folder, no profile). */}
        <span className="session-details">
          <AccountChip configDir={term.configDir} except={account} />
          <CwdChip term={term} />
          <ProfileChip term={term} />
        </span>
      </span>
    </>
  );
  // The buttons sit at the end of the title line. The title line keeps room only for what always
  // shows (data-keep: the pending review count, Ask's mark; without avatars the automation mark and a pinned row's pin
  // too, --row-reserve); pin and close show on hover or focus, over its end, which fades out under them (--row-cover:
  // how far they reach). Pinning never shortens anyone's title while avatars show.
  // The ports at the end of the second line keep their room (--row-ports-w).
  const actionsEl = useRef<HTMLDivElement>(null);
  const portsEl = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const a = actionsEl.current;
    const p = portsEl.current;
    const r = rowEl.current;
    if (!a || !r) return;
    const measure = () => {
      const room = [...a.querySelectorAll<HTMLElement>(':scope > [data-keep]')].reduce((w, el) => w + el.offsetWidth + 4, 0);
      r.style.setProperty('--row-reserve', `${room}px`);
      r.style.setProperty('--row-cover', `${a.offsetWidth}px`);
      r.style.setProperty('--row-ports-w', `${p?.offsetWidth ?? 0}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(a);
    if (p) ro.observe(p);
    return () => ro.disconnect();
  }, [hasPorts, pending > 0, askMark, !!closing, restartAsked, avatars, automated, pinned]);
  // The third line's names never show as stubs.
  useWhoFit(rowEl);
  // Its terminal gone: the row folds away.
  useRowLeave(rowEl, term.id);
  // Dragged inside its band (not while closing), and onto another place while workspaces are on.
  const drag = useRowDrag(term.id, shutting ? undefined : band);
  const dragged = useReorder((st) => st.dragging === term.id);
  const caret = useReorder((st) => (st.caret?.id === term.id ? st.caret.edge : null));
  // ⌥-click: Open to the Side (split view); a row of another workspace waits for a possible double-click.
  const rowClick = useRowClick(term.id, onSelect, () => setEditing(true));
  const kept = pinned && !avatars;
  const pinBtn = !shutting && <PinButton id={term.id} pinned={pinned} session kept={kept} />;
  // It may ask in a bubble beside the row (a dialog), and says when that bubble is open.
  const closeBtn = !shutting && <button type="button" className="row-close" aria-label={t.closeSession} data-tip={t.closeSession} aria-haspopup="dialog" aria-expanded={closing}
    onClick={(e) => { e.stopPropagation(); closeFromRow(term.id, rowEl.current); }}><Icon name="x" size={13} stroke={1.8} /></button>;
  if (restartAsked && !closing) {
    return (
      <div ref={rowEl} role="listitem" data-term-row={term.id} className="session-row is-confirming is-restart-ask" data-own-esc=""
        aria-label={t.restart.askTitle} onKeyDown={onEscCancel(() => useApp.getState().answerRestart('cancel'))}>
        <RowRestartConfirm box={rowEl} term={term} lead={lead} />
      </div>
    );
  }
  // List item with side-by-side buttons (select, pin, close): never a button inside another. While
  // renaming, the field is not inside a button.
  return (
    <div ref={rowEl} role="listitem" data-term-row={term.id} className={`session-row ${enter} ${s ? `state-${state}` : 'is-starting'} ${selected ? 'is-selected' : ''} ${s?.unread ? 'is-unread' : ''} ${popped ? 'is-popped' : ''} ${shutting ? 'is-closing' : ''} ${closing ? 'is-asking' : ''} ${askMark ? 'has-ask' : ''}${avatars ? '' : ' no-avatar'}${dragged ? ' is-dragging' : ''}${caret ? ` is-caret-${caret}` : ''}`}
      data-tip={nameTip(term.title)} {...bandAttr(band)} onContextMenu={(e) => useApp.getState().openMenu(e, sessionRowMenu(term, shutting ? undefined : band))} {...(editing ? {} : drag)}>
      {editing
        ? <div className="row-main">{inner}</div>
        // ⌥-click: Open to the Side (split view).
        : <button type="button" className="row-main" {...rowClick}>{inner}</button>}
      <div ref={actionsEl} className="row-actions">
        {/* Without avatars, started by an automation: the avatar's badge becomes this mark; a click on it is the row's
            (as on the badge, inside the row's button), so it is never a dead spot. */}
        {!avatars && automated && (
          <span className="row-mark is-auto" role="img" aria-label={t.automationMark} data-tip={t.automationMark} data-keep="" {...rowClick}><Icon name="automation" size={11} stroke={1.9} /></span>
        )}
        {/* Ask's mark; in a window of its own, the row's own click (that window comes forward: its Ask is there). */}
        {askMark && (
          <button type="button" className="row-ask" data-keep="" aria-label={popped ? t.companion.markLabelWindow(term.title) : t.companion.markLabel(term.title)} data-tip={`${t.companion.markTip}\n${popped ? t.companion.markTipWindow(term.title) : t.companion.markTipOpen(term.title)}`}
            onClick={(e) => { e.stopPropagation(); if (popped) onSelect(term.id); else openAskFor(term.id); }}><Icon name="ask" size={12} stroke={1.8} /></button>
        )}
        {pending > 0 && (
          <button type="button" className="row-pending" data-keep="" aria-label={t.comments.pendingTip(pending, term.title)} data-tip={t.comments.pendingTip(pending, term.title)}
            onClick={() => useApp.getState().openReview(term.id)}><Icon name="comment" size={12} stroke={1.9} />{pending}</button>
        )}
        {/* A kept pin (pinned, no avatars) never moves: the close comes in at its left, never where the pin was seen. */}
        {kept ? <>{closeBtn}{pinBtn}</> : <>{pinBtn}{closeBtn}</>}
      </div>
      {hasPorts && (
        // Buttons, so never inside the row's own: laid over the end of the second line, which keeps their room.
        // After the row's buttons in the DOM, so Tab reaches pin and close first.
        <div ref={portsEl} className="row-ports"><PortChips id={term.id} compact /></div>
      )}
    </div>
  );
}

/** Rows re-render only when their terminal changes (not on every tick of the others). */
export const SessionRow = memo(SessionRowImpl, (a, b) => a.selected === b.selected && a.pinned === b.pinned && !!a.popped === !!b.popped && a.onSelect === b.onSelect && a.section === b.section && sameBand(a.band, b.band) && a.account === b.account && JSON.stringify(a.term) === JSON.stringify(b.term));
