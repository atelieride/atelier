import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Resumable, TerminalInfo } from '@shared/protocol';
import { Icon } from './Icon';
import { PoppedMarker, SessionRow } from './SessionRow';
import { PinButton } from './PinButton';
import { PinBadge } from './PinBadge';
import { CwdChip } from './CwdChip';
import { ProfileChip } from './ProfileChip';
import { PortChips } from './PortChips';
import { FileTree } from './FileTree';
import { ServicesList } from './ServicesList';
import { Shelf } from './Shelf';
import { ScmSidebar } from '../scm/ScmSidebar';
import { DockerList } from '../docker/DockerList';
import { RedisList } from '../redis/RedisList';
import { useDb } from '../databases/store';
import { DockerPortChips } from '../docker/DockerPorts';
import { displayCommand, resumablesFor, splitTerminals } from '../selectors';
import { ResumeRow } from './ResumeRow';
import { RowCloseConfirm, closeFromRow } from '../confirms/RowConfirm';
import { onEscCancel } from '../confirms/InlineConfirm';
import { RenameInput } from './RenameInput';
import { commitRename } from '../names';
import { t } from '../i18n/en';
import { enterClass } from '../seen';
import { useApp } from '../store';
import { sessionRowMenu } from '../menus';
import { nameTip } from '../names';
import { pinnedFirst } from '../pins';
import { arrangeUnpinned, bandAttr, bandWith, bandsOf, type Band } from '../row-order';
import { useReorder, useReorderDrop } from '../reorder-drag';
import { groupSessions, trackSections, type Entered, type InboxSection } from '../inbox';
import { WorkspaceGroup, WsOwnRows, useRowClick, useRowDrag } from './WorkspaceGroup';
import { WsActivityGroup } from './WsActivityGroup';
import { cardOf, inWorkspace, resumablesIn, wsActivityCard } from '../workspace-view';
import { activitiesOf, isOpen, workspaceOf, workspacesOf, type WorkspacesState } from '../workspaces';
import { kbd } from '../kbd';
import { newTerminalIn } from '../launch';
import { openBelow, openNewMenu, sessionPlusMenu } from '../menus';
import type { MenuItem } from '../menu-model';
import { useRowFit, type RowFitParts } from '../row-fit';

// Automations are opt-in (2026-11-02): their list loads on first use (App.tsx does the same for the view and sheets).
const AutomationsList = lazy(() => import('../automations/AutomationsList').then((m) => ({ default: m.AutomationsList })));
// The Databases sidebar too, with its stylesheet (the live demo's first paint); its head shows meanwhile.
const DatabasesList = lazy(() => import('../databases/DatabasesList').then((m) => ({ default: m.DatabasesList })));
// Find in Files too: the view, its list, its stylesheet and strings come with its chunk; its head shows meanwhile.
const FindInFiles = lazy(() => import('../search/FindInFiles').then((m) => ({ default: m.FindInFiles })));

/**
 * The Databases head while its chunk loads, laid out as the list's own — title, count, the room of its two buttons — so
 * nothing moves when it arrives (their icons come with it).
 */
function DbHeadLoading() {
  const count = useDb((s) => s.snap.connections.length);
  return (
    <div className="sidebar-head">
      <span className="section-label">{t.db.title}</span>
      {count > 0 && <span className="section-label mono db-head-count">{count}</span>}
      <span className="grow" />
      <span className="icon-btn" /><span className="icon-btn" />
    </div>
  );
}

/** Find in Files' head while its chunk loads: its name and the room of its three buttons, as the view lays them out. */
function SearchHeadLoading() {
  return (
    <div className="sidebar-head">
      <span className="section-label">{t.activity.search.replace(/ \(.*\)$/, '')}</span>
      <span className="grow" />
      <span className="icon-btn" /><span className="icon-btn" /><span className="icon-btn" />
    </div>
  );
}

function Head({ label, count, children }: { label: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="sidebar-head">
      <span className="section-label">{label}</span>
      {count !== undefined && count > 0 && <span className="count mono">{count}</span>}
      <span className="grow" />
      {children}
    </div>
  );
}

/**
 * Resume all running: "3 of 6", a progress bar and Stop, at the top of Sessions. Never
 * below the list: each session coming back adds a row above, and Stop would slide away from the pointer.
 */
function ResumeRun() {
  const bulk = useApp((s) => s.bulkResume);
  if (!bulk) return null;
  return (
    <div className="resume-run" role="group" aria-label={t.resumeAllTip}>
      <div className="resume-run-line">
        <Icon name="resume" size={12} stroke={1.8} />
        <span className="resume-run-label">{t.resumeRunning}</span>
        <span className="resume-progress-text mono" aria-live="polite">{t.resumeProgress(bulk.done, bulk.total)}</span>
        <span className="grow" />
        {!bulk.stopped && <button type="button" className="resume-stop" onClick={() => useApp.getState().stopResumeAll()}>{t.resumeStop}</button>}
      </div>
      <div className="resume-progress" role="progressbar" aria-label={t.resumeAllTip} aria-valuemin={0} aria-valuemax={bulk.total} aria-valuenow={bulk.done}>
        <i style={{ width: `${Math.round((bulk.done / bulk.total) * 100)}%` }} />
      </div>
    </div>
  );
}

/** The Resume section's head: Pinned (when a pinned session waits) and All; inside an activity (`place`), its sessions. */
function ResumeHead({ count, pinned, place }: { count: number; pinned: number; place?: string }) {
  const bulk = useApp((s) => s.bulkResume);
  // Dismiss All… asks in the Resume head of the place it was asked for.
  const dismissAsk = useApp((s) => s.dismissAllAsk && s.dismissAllPlace === (place ?? null));
  const st = useApp.getState;
  if (dismissAsk && !bulk) {
    return (
      <div className="sidebar-head resume-head is-confirming" role="group" aria-label={t.dismissAllQ(count)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); st().cancelDismissAll(); } }}>
        <span className="resume-confirm-text" data-tip={t.dismissAllNote}>{t.dismissAllQ(count)}</span>
        <span className="grow" />
        <button type="button" className="resume-pill" autoFocus onClick={() => st().cancelDismissAll()}>{t.confirm.cancel}</button>
        <button type="button" className="resume-pill is-danger" onClick={() => void st().confirmDismissAll()}>{t.dismissAllGo}</button>
      </div>
    );
  }
  // While Resume all runs, its progress is at the top of Sessions (ResumeRun): here only the label.
  if (bulk) {
    return (
      <div className="sidebar-head resume-head is-running">
        <span className="section-label">{t.toResume}</span>
        <span className="count mono">{count}</span>
      </div>
    );
  }
  return (
    <div className="sidebar-head resume-head">
      <span className="section-label">{t.toResume}</span>
      {count > 0 && <span className="count mono">{count}</span>}
      <span className="grow" />
      {pinned > 0 && (
        <button type="button" className="resume-pill" data-tip={t.resumePinnedTip} aria-label={t.resumePinnedTip} onClick={() => void st().resumeAll('pinned', place)}>
          <Icon name="pin" size={11} stroke={1.8} />{t.resumePinned}<span className="mono">{pinned}</span>
        </button>
      )}
      <button type="button" className="resume-pill is-all" data-tip={t.resumeAllTip} aria-label={t.resumeAllTip} onClick={() => void st().resumeAll('all', place)}>
        <Icon name="resume" size={11} stroke={1.8} />{t.resumeAll}
      </button>
    </div>
  );
}

const TERM_FIT: RowFitParts = {
  name: '.term-name',
  // The command, not "Closing…" (also .term-cmd, without .mono: it stays on a compact row).
  chips: '.row-main > :is(.cwd-chip, .profile-chip, .term-cmd.mono), :scope > .port-chips',
  busy: ':hover, :has(:focus-visible), :has(.row-pin:focus, .row-close:focus), :has(.rename-input), .is-confirming'
};

function TermRow({ term, selected, pinned, popped, onSelect, band }: { term: TerminalInfo; selected: boolean; pinned: boolean; popped: boolean; onSelect: (id: string) => void; band?: Band }) {
  const [enter] = useState(() => enterClass(term.id));
  // Rename from the row's menu happens here, in the row; double-click too, as on a session row.
  const [editingHere, setEditing] = useState(false);
  const asked = useApp((s) => s.renaming?.id === term.id && s.renaming.at === 'row');
  const editing = editingHere || asked;
  const stop = () => { setEditing(false); if (asked) useApp.getState().setRenaming(null); };
  // Its close asked here: the row turns into the question.
  const closing = useApp((s) => (s.closeAsk?.id === term.id && s.closeAsk.at === 'row' ? s.closeAsk : null));
  // Its close sent: "Closing…" until atelierd drops it, and nothing closes it again.
  const shutting = useApp((s) => !!s.closing[term.id]);
  const rowEl = useRef<HTMLDivElement>(null);
  // Its chips give way to its name; hovered or keyboard-focused, pin and close borrow room.
  useRowFit(rowEl, TERM_FIT);
  // Dragged inside its band (not while closing), and onto another place while workspaces are on.
  const drag = useRowDrag(term.id, shutting ? undefined : band);
  const dragged = useReorder((s) => s.dragging === term.id);
  const caret = useReorder((s) => (s.caret?.id === term.id ? s.caret.edge : null));
  // ⌥-click: Open to the Side; a row of another workspace waits for a possible double-click.
  const rowClick = useRowClick(term.id, onSelect, () => setEditing(true));
  if (closing) {
    return (
      <div ref={rowEl} role="listitem" data-term-row={term.id} className="term-row is-confirming" data-own-esc="" aria-label={t.confirm.closeTitle(term.title)}
        onKeyDown={onEscCancel(() => useApp.getState().cancelClose())}>
        <RowCloseConfirm box={rowEl} title={term.title} stops={closing.stops} note={closing.note} session={false}
          lead={<span className="term-icon"><Icon name="terminal" size={13} stroke={1.8} /></span>} />
      </div>
    );
  }
  const inner = (
    <>
      <span className="term-icon"><Icon name="terminal" size={13} stroke={1.8} />{pinned && <PinBadge />}</span>
      {editing
        ? <RenameInput value={term.title} onCommit={(v) => { stop(); commitRename(term, v); }} onCancel={stop} />
        : <span className="term-name">{term.title}</span>}
      {!editing && popped && <PoppedMarker />}
      {!editing && <CwdChip term={term} />}
      {!editing && <ProfileChip term={term} />}
      <span className={shutting ? 'term-cmd' : 'term-cmd mono'}>{shutting ? t.closingRow : displayCommand(term)}</span>
    </>
  );
  return (
    <div ref={rowEl} role="listitem" data-term-row={term.id} className={`term-row ${enter} ${selected ? 'is-selected' : ''} ${popped ? 'is-popped' : ''} ${shutting ? 'is-closing' : ''}${dragged ? ' is-dragging' : ''}${caret ? ` is-caret-${caret}` : ''}`} data-tip={nameTip(term.title)}
            {...bandAttr(band)} onContextMenu={(e) => useApp.getState().openMenu(e, sessionRowMenu(term, shutting ? undefined : band))} {...(editing ? {} : drag)}>
            {editing
              // While renaming, the field is not inside a button.
              ? <div className="row-main">{inner}</div>
              : <button type="button" className="row-main" {...rowClick}>{inner}</button>}
            <PortChips id={term.id} compact />
            <DockerPortChips term={term} compact />
            {!shutting && <PinButton id={term.id} pinned={pinned} session={false} />}
            {!shutting && <button type="button" className="row-close" aria-label={t.closeTerminal} data-tip={t.closeTerminal}
              onClick={(e) => { e.stopPropagation(); closeFromRow(term.id, rowEl.current); }}><Icon name="x" size={13} stroke={1.8} /></button>}
          </div>
  );
}

/** Group by state: lights its icon only when on. */
function GroupToggle() {
  const grouped = useApp((s) => s.groupByState);
  return (
    <button type="button" className={`icon-btn group-toggle ${grouped ? 'is-on' : ''}`} aria-pressed={grouped} aria-label={t.groupByState}
      data-tip={t.groupByStateTip} onClick={() => useApp.getState().toggleGroupByState()}><Icon name="inbox" size={14} /></button>
  );
}

/**
 * A head's "+": where the thing it starts lives. `menu`: a click opens these items below it
 * instead (Sessions' drop-down).
 */
function PlusButton({ label, keys, onClick, menu, onContextMenu }: { label: string; keys: string; onClick?: () => void; menu?: () => MenuItem[]; onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="icon-btn head-plus" aria-label={label} data-tip={label} data-kbd={kbd(keys)} aria-haspopup={menu ? 'menu' : undefined}
      onClick={(e) => { if (menu) openBelow(e.currentTarget, menu()); else onClick?.(); }} onContextMenu={onContextMenu}>
      <Icon name="plus" size={14} />
    </button>
  );
}

const newSessionNow = () => useApp.getState().setNewSessionOpen(true);
const sessionsPlusMenu = () => sessionPlusMenu({ session: newSessionNow, folder: () => useApp.getState().setFolderSheet({ kind: 'session' }) });
const newTerminalNow = () => void newTerminalIn();
/** Right-click on Sessions' "+": the whole New menu (Session in Folder…, accounts, terminals). */
const newMenuAt = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.preventDefault();
  void openNewMenu(e.currentTarget, { session: newSessionNow, terminal: newTerminalNow });
};

/**
 * Today's sections — Sessions, To resume, Terminals — for these terminals and sessions to resume. The sidebar's body
 * with workspaces off. In a workspace's group the same rows without the Sessions and Terminals
 * labels, the Resume head only from two rows to resume, and a line when there is nothing at all.
 */
/**
 * A list's sections. In a group: `empty` is what an empty one says (null: nothing), `place` the activity whose Resume
 * head acts on its own sessions.
 */
function Sections({ terminals, toResume, entered, scope, inGroup = false, empty = t.ws.groupEmpty, place }: {
  terminals: TerminalInfo[]; toResume: Resumable[]; entered: Map<string, Map<string, Entered>>; scope: string; inGroup?: boolean; empty?: string | null; place?: string;
}) {
  // Launched as sessions and still starting: listed (and drawn) as sessions, never under Terminals.
  const starting = useApp((s) => s.starting);
  // The selected row is the tab in front, as in the tab bar: a file or another view in front leaves every row plain
  // (selectedId stays the last terminal shown).
  const front = useApp((s) => s.activeKey());
  const pins = useApp((s) => s.pins);
  // Resume all: the rows still waiting their turn.
  const queue = useApp((s) => s.bulkResume?.queue);
  const grouped = useApp((s) => s.groupByState);
  // In windows of their own: marked, never shown as the selected row (a click brings the window forward).
  const poppedOut = useApp((s) => s.poppedOut);
  const isPopped = (id: string) => poppedOut.includes(`t:${id}`);
  const isFront = (id: string) => front === `t:${id}` && !isPopped(id);
  const onSelect = useCallback((id: string) => useApp.getState().select(id), []);
  // When each row entered its section: rows keep their place while they stay in it (a tool call doesn't reorder them).
  // Kept by the always-mounted Sidebar, one map per workspace (or the whole project's): another view, a workspace
  // switch or a folded block never resets it.
  const split = splitTerminals(terminals, starting);
  const tracked = trackSections(entered.get(scope) ?? new Map<string, Entered>(), split.sessions, Date.now());
  useEffect(() => { entered.set(scope, tracked); });
  // The order rows were put in by hand: unpinned ones follow it, the ones never placed keep today's place.
  const order = useApp((s) => s.rowOrder);
  const groups = grouped ? groupSessions(split.sessions, pins, tracked, order.sessions) : [];

  // Pinned rows first, in pin order; the rest in their manual order, then by age as before.
  const sessions = pinnedFirst(arrangeUnpinned(split.sessions, order.sessions, 'last'), pins);
  const shells = pinnedFirst(arrangeUnpinned(split.shells, order.terminals, 'last'), pins);
  // What a row can be dragged among: grouped by state, only Idle's rows (the other sections order themselves).
  const sessionBands = bandsOf('sessions', grouped ? groups.find((g) => g.key === 'idle')?.items ?? [] : sessions, pins);
  const shellBands = bandsOf('terminals', shells, pins);
  const sessionDrop = useReorderDrop(sessionBands);
  const shellDrop = useReorderDrop(shellBands);
  const queued = new Set(queue ?? []);
  const row = (x: TerminalInfo, section?: InboxSection) => <SessionRow key={x.id} term={x} selected={isFront(x.id)} pinned={pins.includes(x.id)} popped={isPopped(x.id)} onSelect={onSelect} section={section}
    band={bandWith(sessionBands, x.id) ?? undefined} />;
  const nothing = sessions.length === 0 && shells.length === 0 && toResume.length === 0 && queue === undefined;
  if (inGroup && nothing) return empty === null ? null : <p className="ws-none">{empty}</p>;
  return (
    <>
      {!inGroup && (
        <Head label={t.sessions} count={sessions.length}>
          <GroupToggle />
          <PlusButton label={t.newSession} keys="⌘N" menu={sessionsPlusMenu} onContextMenu={newMenuAt} />
        </Head>
      )}
      {/* In groups, once above them all (Workspaces): Resume all runs over the whole project. */}
      {!inGroup && <ResumeRun />}
      {grouped && sessions.length > 0 ? (
        // One list with the section heads among the rows: a row changing section is moved, not mounted again, so it
        // keeps the keyboard focus and an unfinished rename.
        <div ref={sessionDrop.ref} className="list inbox" role="list" aria-label={t.sessions} {...sessionDrop.handlers}>
          {groups.flatMap((g) => [
            <div key={`head:${g.key}`} className={`inbox-head is-${g.key}`} role="none">
              {/* The state alone: numbers only on the macro areas' heads (2026-11-02). */}
              <i className="inbox-dot" aria-hidden="true" /><span className="section-label">{t.inbox[g.key]}</span>
            </div>,
            ...g.items.map((x) => row(x, g.key))
          ])}
        </div>
      ) : (
        <div ref={sessionDrop.ref} className="list" role="list" aria-label={t.sessions} {...sessionDrop.handlers}>
          {sessions.map((x) => row(x))}
          {sessions.length === 0 && !inGroup && <p className="empty">{t.emptySessionsBody}</p>}
        </div>
      )}
      {toResume.length > 0 && (
        <>
          {(!inGroup || toResume.length > 1) && <ResumeHead count={toResume.length} pinned={toResume.filter((r) => pins.includes(r.id)).length} place={place} />}
          <div className="list">{toResume.map((r) => <ResumeRow key={r.id} r={r} pinned={pins.includes(r.id)} queued={queued.has(r.id)} />)}</div>
        </>
      )}
      {shells.length > 0 && !inGroup && (
        <Head label={t.terminals} count={shells.length}>
          <PlusButton label={t.newTerminal} keys="⌘T" onClick={newTerminalNow} />
        </Head>
      )}
      <div ref={shellDrop.ref} className="list" role="list" aria-label={t.terminals} {...shellDrop.handlers}>
        {shells.map((term) => <TermRow key={term.id} term={term} selected={isFront(term.id)} pinned={pins.includes(term.id)} popped={isPopped(term.id)} onSelect={onSelect}
          band={bandWith(shellBands, term.id) ?? undefined} />)}
      </div>
    </>
  );
}

/**
 * Workspaces on: every workspace is a group — a quiet head and, open, its rows indented under
 * it; only chevrons fold (a workspace left behind stays as it showed), and the one in front opens. The Shelf stays
 * below, the whole project's.
 */
function Workspaces({ ws, entered }: { ws: WorkspacesState; entered: Map<string, Map<string, Entered>> }) {
  const terminals = useApp((s) => s.terminals);
  const resumables = useApp((s) => s.resumables);
  const root = useApp((s) => s.project?.root ?? '');
  const pins = useApp((s) => s.pins);
  const openFiles = useApp((s) => s.openFiles);
  const paths = openFiles.map((f) => f.path);
  // Files at a commit count too: a workspace holding only those isn't empty (tables are Databases').
  const revFiles = useApp((s) => s.revFiles);
  const tabs = revFiles.map((f) => f.key);
  const withActivities = useApp((s) => s.settings.wsActivities);
  const wss = workspacesOf(ws);
  const here = workspaceOf(ws, ws.active);
  return (
    <>
      <Head label={t.ws.workspaces} count={wss.length}>
        <GroupToggle />
        <button type="button" className="icon-btn head-plus" aria-label={t.ws.newWorkspace} data-tip={t.ws.newWorkspace} data-kbd={kbd('⌘⌥T')}
          onClick={() => useApp.getState().setWsSheet({})}><Icon name="plus" size={14} /></button>
      </Head>
      <ResumeRun />
      <div className="ws-list">
        {wss.map((w) => {
          const open = isOpen(ws, w.id);
          const acts = withActivities ? activitiesOf(ws, w.id) : [];
          const atOwn = ws.active === w.id;
          // With activities on, its own rows' Resume head acts on its own sessions, whatever place is in front.
          const own = <Sections terminals={inWorkspace(ws, w.id, terminals)} toResume={pinnedFirst(resumablesIn(ws, w.id, resumables, root), pins)} entered={entered} scope={`ws:${w.id}`} inGroup
            empty={acts.length ? null : t.ws.groupEmpty} {...(withActivities ? { place: w.id } : {})} />;
          return (
            <WorkspaceGroup key={w.id} w={w} active={here === w.id} inAct={here === w.id && !atOwn} open={open} card={cardOf(ws, w.id, terminals, resumables, root, paths, tabs)}>
              {/* Its activities first, at the same indent as its own rows; then its own rows, a drop zone of its own tabs. */}
              {open && acts.map((a) => {
                const aOpen = isOpen(ws, a.id);
                return (
                  <WsActivityGroup key={a.id} a={a} color={w.color} current={ws.active === a.id} open={aOpen} card={wsActivityCard(ws, a.id, terminals, resumables, root, paths, tabs)}>
                    {aOpen && <Sections terminals={inWorkspace(ws, a.id, terminals)} toResume={pinnedFirst(resumablesIn(ws, a.id, resumables, root), pins)} entered={entered} scope={`act:${a.id}`} inGroup
                      empty={t.wsAct.emptyRows} place={a.id} />}
                  </WsActivityGroup>
                );
              })}
              {open && (acts.length ? <WsOwnRows wsId={w.id} atOwn={atOwn}>{own}</WsOwnRows> : own)}
            </WorkspaceGroup>
          );
        })}
      </div>
    </>
  );
}

export function Sidebar() {
  const activity = useApp((s) => s.activity);
  const terminals = useApp((s) => s.terminals);
  const resumables = useApp((s) => s.resumables);
  const project = useApp((s) => s.project);
  const pins = useApp((s) => s.pins);
  const ws = useApp((s) => (s.ws?.on && !s.popout ? s.ws : null));
  // When each row entered its section, per list: here, above the views' early returns, so it survives them.
  const entered = useRef(new Map<string, Map<string, Entered>>());
  // Hidden: nothing drawn, this component kept so `entered` survives until it shows again.
  const hidden = useApp((s) => s.sidebarHidden);

  if (hidden) return null;
  if (activity === 'files') return <aside className="sidebar"><FileTree /></aside>;
  if (activity === 'search') return <aside className="sidebar is-search"><Suspense fallback={<SearchHeadLoading />}><FindInFiles /></Suspense></aside>;
  if (activity === 'services') return <aside className="sidebar"><ServicesList /></aside>;
  if (activity === 'scm') return <aside className="sidebar is-scm"><ScmSidebar /></aside>;
  if (activity === 'docker') return <aside className="sidebar is-docker"><DockerList /></aside>;
  if (activity === 'redis') return <aside className="sidebar is-docker is-redis"><RedisList /></aside>;
  if (activity === 'databases') return <aside className="sidebar is-db"><Suspense fallback={<DbHeadLoading />}><DatabasesList /></Suspense></aside>;
  if (activity === 'automations') return <aside className="sidebar is-automations"><Suspense fallback={null}><AutomationsList /></Suspense></aside>;

  if (ws) return <aside className="sidebar is-sessions is-workspaces"><Workspaces ws={ws} entered={entered.current} /><Shelf /></aside>;
  // Pinned sessions keep their pin while they wait to be resumed: first, in pin order.
  const toResume = project ? pinnedFirst(resumablesFor(resumables, project.root), pins) : [];
  return (
    <aside className="sidebar is-sessions">
      <Sections terminals={terminals} toResume={toResume} entered={entered.current} scope="all" />
      <Shelf />
    </aside>
  );
}
