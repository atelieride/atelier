import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { TerminalInfo } from '@shared/protocol';
import { isWaiting } from '@shared/session-view';
import { shownState } from '../selectors';
import { SessionGlyph } from './SessionTile';
import { FileIcon } from './FileIcon';
import { Icon } from './Icon';
import { useDocker } from '../docker/store';
import { dockerTabTitle } from '../docker/DockerView';
import { parseRedisKey, redisTabTitle } from '../redis/tabs';
import { redisViewsMenu } from '../redis/actions';
import { spaceOf } from '../spaces';
import { useRedis } from '../redis/store';
import { isMarkdownTab } from '../markdown-views';
import { ProfileChip } from './ProfileChip';
import { AccountChip } from './AccountChip';
import { RenameInput } from './RenameInput';
import { t } from '../i18n/en';
import { commitRename, nameTip, syncTip } from '../names';
import { useApp, type OpenFile } from '../store';
import type { TabKey } from '../tabs-model';
import { paneMenu, tabMenu } from '../menus';
import { tabPropsEqual } from '../tab-props';
import { reviewScopeTitle } from '../review';
import { historyTabTitle, revTitle } from '../scm/titles';
import { isStarting } from '../starting';
import { keepInView, planWheel, revealClicked, revealLeft, stripFade, wheelToStrip } from '../tab-strip';
import { realPath, worktreeAt } from '../worktrees';
import { isExternal, outsideDir } from '../external';
import { dockTargetAt } from '../dock-target';
import { pressTab, sameSpot } from '../tab-drag';
import { MAX_PANES, gridColumns, stripKeys, unsplitTarget } from '../split';
import { isProjectKey } from '../workspaces';
import { kbd } from '../kbd';
import { wsChangeCount } from '../workspace-view';
import { keepPaneKeyboard } from '../pane-focus';
import { useShallow } from 'zustand/react/shallow';
import { useDb } from '../databases/store';
import { DB_TAB_ICON, dbConnsIf, dbTabLabel, dbTabTip, shownDbTabsIf, type DbTabKind, type DbTabRef } from '../databases/tabs';
import { envClass, type EnvClass } from '../databases/view';
import type { DockerContainer } from '@shared/docker';
import type { AutoTabRef, DockerTabRef } from '../store';
import type { AutomationView } from '@shared/api';
import { autoTabTitle } from '../automations/tabs';

const NO_DOCKER_TABS: DockerTabRef[] = [];
const NO_CONTAINERS: DockerContainer[] = [];
const NO_AUTO_TABS: AutoTabRef[] = [];
const NO_AUTOMATIONS: AutomationView[] = [];

// Room kept between a revealed tab and the strip's edge, so it is not under the edge fade (layout.css, 32px).
const REVEAL_PAD = 32;

/** A double click on a tab: the preview it is — a file's, or a table's — kept open as a normal tab. */
export function keepTabOpen(k: TabKey): void {
  const st = useApp.getState();
  if (k.startsWith('f:')) st.keepOpen(k.slice(2));
  else if (k.startsWith('db:')) st.keepDbTab(k);
  else if (k.startsWith('dk:')) st.keepDockerTab(k);
  else if (k.startsWith('au:')) st.keepAutoTab(k);
}

/** A table tab: its kind's icon, its connection's environment (null: unknown here), its tooltip. */
interface DbShown { kind: DbTabKind; env: EnvClass | null; tip: string }

/** active: the focused pane's tab in front; front: another pane's tab in front (split view); leaving: lit by its pane's × (it would move). */
/** badge: a count after the name (Redis Queues' failed jobs). */
interface TabProps { k: TabKey; active: boolean; front?: boolean; drop: boolean; lifted?: boolean; leaving?: boolean; term?: TerminalInfo; starting?: boolean; file?: OpenFile; svcErrors?: number; title?: string; db?: DbShown; badge?: number }

const Tab = memo(function Tab({ k, active, front, drop, lifted, leaving, term, starting, file, svcErrors, title, db, badge }: TabProps) {
  const st = useApp.getState;
  const name = term ? term.title : file ? (file.rel.split('/').at(-1) ?? file.rel) : k === 'review' ? t.review.tab(title ?? '') : k === 'background' ? t.bg.tab(title ?? '') : k === 'history' || k.startsWith('rev:') || k.startsWith('db:') || k.startsWith('dk:') || k.startsWith('rd:') || k.startsWith('au:') ? title ?? '' : t.servicesTab;
  const close = () => st().closeTab(k.startsWith('f:') ? k.slice(2) : k);
  const renaming = useApp((s) => !!term && s.renaming?.id === term.id && s.renaming.at === 'tab');
  const dirty = useApp((s) => !!file && !!s.dirty[file.path]);
  // Italic until kept: the file preview, or the table preview (a slot of its own).
  const preview = useApp((s) => (!!file && s.preview === file.path) || (!!db && s.dbPreview === k) || s.dockerPreview === k || s.autoPreview === k);
  // A Markdown file in Preview: a small eye after its name.
  const mdPreview = useApp((s) => !!file && s.mdViewOf(file.path) === 'preview' && isMarkdownTab(file.path, s.langOverrides));
  // A file inside a linked worktree: a glyph, and the tooltip says which worktree.
  const wt = useApp((s) => { const w = file ? worktreeAt(s.repos, realPath(file.path, s.project)) : null; return w ? `${w.name}/${w.rel}` : null; });
  // A file outside the project: the folder holding it, after its name.
  const outside = useApp((s) => !!file && isExternal(file.path, s.project?.realRoot ?? null));
  // A file opened from a terminal link into Claude's temp folder.
  const claudeTemp = useApp((s) => !!file && !!s.claudeTemp[file.path]);
  const outsideTip = file && outside ? (claudeTemp ? t.claudeTemp.tabTip(file.rel) : t.openAny.tabTip(file.rel)) : undefined;
  const commit = (v: string) => { st().setRenaming(null); if (term) commitRename(term, v); };
  return (
    <div role="tab" aria-selected={active || !!front} tabIndex={active ? 0 : -1} data-key={k}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st().activate(k); } }}
      className={`tab ${active ? 'is-active' : ''} ${front ? 'is-front' : ''} ${leaving ? 'is-leaving' : ''} ${drop ? 'is-drop' : ''} ${lifted ? 'is-lifted' : ''} ${preview ? 'is-preview' : ''} ${isWaiting(term?.session) ? 'is-waiting' : ''}${db ? ' is-db' : ''}${db?.env === 'is-prod' ? ' is-prod' : ''}`}
      // The full name heads the tip (the ellipsis may cut it); a file's path already ends with it (an outside file's
      // then says so, which screen readers get as the tab's description). A session's: its folder, then where Claude
      // stands on the name (session name sync: the bar above a single terminal has no name).
      // A table's: its connection, schema and name.
      aria-description={outsideTip}
      data-tip={wt ?? outsideTip ?? file?.rel ?? db?.tip ?? (term ? nameTip(name, [term.session?.cwd ?? term.cwd, syncTip(term)].filter(Boolean).join('\n')) : k === 'services' ? undefined : nameTip(name))}
      // ⌥-click: Move to Right Pane (from the last pane, a new pane on the right).
      onClick={(e) => (e.altKey ? st().moveTabSide(k, 1) : st().activate(k))}
      // Double click on the preview tab keeps it open as a normal tab.
      onDoubleClick={() => keepTabOpen(k)}
      onContextMenu={(e) => st().openMenu(e, tabMenu(k))}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(); } }}
      // Pressed and moved: dragged with the pointer (tab-drag.ts), to a strip, a pane, or out into a window of its own.
      onPointerDown={(e) => { const strip = e.currentTarget.closest<HTMLElement>('.tab-strip'); if (strip && !renaming) pressTab(e.nativeEvent, k, e.currentTarget, strip); }}>
      {/* A session still starting already has its avatar or tile (starting.ts): no terminal glyph that turns into one. */}
      {term && (term.session || starting
        ? <SessionGlyph term={term} state={shownState(term)} size={16} />
        : <span className="tab-term"><Icon name="terminal" size={12} stroke={1.9} /></span>)}
      {file && <FileIcon name={name} />}
      {k === 'services' && <i className={`svc-dot ${svcErrors ? 'is-err' : 'is-ok'}`} />}
      {k === 'review' && <span className="tab-term"><Icon name="review" size={13} stroke={1.8} /></span>}
      {k === 'history' && <span className="tab-term"><Icon name="git" size={13} stroke={1.8} /></span>}
      {k === 'background' && <span className="tab-term"><Icon name="bolt" size={13} stroke={1.8} /></span>}
      {k.startsWith('dk:') && <span className="tab-term tab-whale"><Icon name="whale" size={14} /></span>}
      {k.startsWith('rd:') && <span className="tab-term"><Icon name="redis" size={13} stroke={1.8} /></span>}
      {k.startsWith('au:') && <span className="tab-term"><Icon name="automation" size={13} stroke={1.8} /></span>}
      {k.startsWith('rev:') && <span className="tab-rev"><FileIcon name={(title ?? '').split(' @ ')[0] ?? ''} /><i className="tab-rev-badge" aria-hidden="true"><Icon name="git" size={8} stroke={2.4} /></i></span>}
      {db && <span className="tab-db" role="img" aria-label={t.db.tab.kind[db.kind]}><Icon name={DB_TAB_ICON[db.kind]} size={14} stroke={1.7} /></span>}
      {renaming
        ? <RenameInput value={name} className="tab-rename" onCommit={commit} onCancel={() => st().setRenaming(null)} />
        : <span className={`tab-name${term?.nameSync ? ` name-${term.nameSync}` : ''}`}>{name}</span>}
      {db?.env && <i className={`tab-env ${db.env}`} aria-hidden="true" />}
      {!!badge && <span className="mono tab-badge">{badge}</span>}
      {file && outside && !renaming && <span className="tab-dir" aria-hidden="true">{outsideDir(file.rel)}</span>}
      {mdPreview && <span className="tab-md" role="img" aria-label={t.md.inPreview}><Icon name="eye" size={12} stroke={1.8} /></span>}
      {wt && <span className="tab-wt" aria-label={t.wt.inWorktree(wt.split('/')[0]!)}><Icon name="branchOff" size={12} stroke={1.9} /></span>}
      {term && !renaming && <ProfileChip term={term} />}
      {term && !renaming && <AccountChip configDir={term.configDir} />}
      {dirty && <span className="tab-dirty" aria-label={t.modified} />}
      {/* Every tab's X closes the tab only: a terminal keeps running and stays in the sidebar (its row's X closes it). */}
      <button type="button" className="tab-close" aria-label={t.closeTab}
        onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="x" size={12} stroke={1.9} /></button>
      <i className="tab-feet" aria-hidden />
    </div>
  );
}, (a, b) => tabPropsEqual(a, b) && a.lifted === b.lifted && !!a.leaving === !!b.leaving);

/**
 * The tab bar: with one pane, today's bar — the strip, "+", the Changes toggle. Split, the
 * row keeps its height and is cut into one strip per pane, each exactly above its pane (the panes' own columns, so a
 * divider moves the strips' edges too), with the pane tools at its end; the last strip ends with the Changes toggle.
 */
export function Tabs({ onNew }: { onNew: (anchor: HTMLElement) => void }) {
  const count = useApp((s) => s.split.panes.length);
  const fractions = useApp((s) => s.split.fractions);
  // A stable "+" handler: the memoized strips never re-render for a divider drag (only the grid's columns change).
  const newRef = useRef(onNew);
  newRef.current = onNew;
  const stableNew = useCallback((anchor: HTMLElement) => newRef.current(anchor), []);
  if (count <= 1) return <div className="tabs"><PaneStrip pane={0} split={false} last onNew={stableNew} /></div>;
  return (
    <div className="tabs is-split" style={{ gridTemplateColumns: gridColumns(fractions) }}>
      {Array.from({ length: count }, (_, i) => <PaneStrip key={i} pane={i} split last={i === count - 1} onNew={stableNew} />)}
    </div>
  );
}

/** One strip: pane `pane`'s tabs (one pane: every tab), its "+", in a split its tools, and on the last the Changes toggle. */
export const PaneStrip = memo(function PaneStrip({ pane, split, last, onNew }: { pane: number; split: boolean; last: boolean; onNew: (anchor: HTMLElement) => void }) {
  const order = useApp((s) => stripKeys(s.split, s.tabOrder, pane));
  const space = useApp((s) => s.space);
  // Workspaces on: the project views after a separator, the same in every workspace.
  const wsOn = useApp((s) => !!s.ws?.on && !s.popout);
  const projectAt = wsOn ? order.findIndex(isProjectKey) : -1;
  const terminals = useApp((s) => s.terminals);
  const starting = useApp((s) => s.starting);
  const openFiles = useApp((s) => s.openFiles);
  // The tab this strip shows in front, and whether its pane has the focus (one pane: the active tab, always focused).
  const front = useApp((s) => (split ? s.split.panes[pane]?.front ?? null : s.activeKey()));
  const focused = useApp((s) => !split || s.split.focus === pane);
  const serviceErrors = useApp((s) => s.services.reduce((n, p) => n + p.errors, 0));
  const reviewTitle = useApp((s) => (s.review ? reviewScopeTitle(s.review.scope, s.terminals, s.attributions) : ''));
  const historyTitle = useApp((s) => historyTabTitle(s));
  const backgroundTitle = useApp((s) => s.terminals.find((x) => x.id === s.backgroundTab?.terminalId)?.title ?? '');
  // Docker tabs: named by their target; a strip with none reads fixed empty lists.
  const hasDocker = order.some((k) => k.startsWith('dk:'));
  const dockerTabs = useApp((s) => (hasDocker ? s.dockerTabs : NO_DOCKER_TABS));
  const containers = useDocker((s) => (hasDocker ? s.containers : NO_CONTAINERS));
  const dockerTitle = (k: TabKey) => { const r = dockerTabs.find((x) => x.key === k); return r ? dockerTabTitle(r.target, containers) : ''; };
  // Redis tabs: named by their view; Queues carries the failed jobs' count.
  // Automations tabs: named by their automation.
  const hasAuto = order.some((k) => k.startsWith('au:'));
  const autoTabs = useApp((s) => (hasAuto ? s.autoTabs : NO_AUTO_TABS));
  const automations = useApp((s) => (hasAuto ? s.automations.automations : NO_AUTOMATIONS));
  const failedJobs = useRedis((s) => (order.includes('rd:queues') ? (s.status?.queues ?? []).reduce((n, q) => n + (q.counts.failed ?? 0), 0) : 0));
  const revFiles = useApp((s) => s.revFiles);
  // Table tabs: named among those this window shows, colored from its connections. A strip
  // with none reads a fixed empty list: a snapshot from main, or a table opened elsewhere, never re-renders it.
  const hasDb = order.some((k) => k.startsWith('db:'));
  const dbTabs = useApp(useShallow(shownDbTabsIf(hasDb)));
  const conns = useDb(dbConnsIf(hasDb));
  // A tab dragged here (tab-drag.ts), or a pop-out dragged back over this strip: the caret before the tab it would
  // land in front of (the "+" for the end). None where the dragged tab would stay where it is.
  const dragging = useApp((s) => s.tabDrag);
  const dragTarget = useApp((s) => s.tabDragTarget);
  // A pop-out of another space lands in its own space, never here: no caret in this strip.
  const hover = useApp((s) => (s.tabDrag || (s.dockHover?.key && spaceOf(s.dockHover.key as TabKey) !== s.space) ? null : s.dockHover));
  const dockBefore = useMemo(() => {
    const target = dragging ? dragTarget : hover ? dockTargetAt(hover) : null;
    if (target?.kind !== 'strip' || target.pane !== pane) return null;
    if (dragging && sameSpot(order, dragging, target)) return null;
    return target.before ?? 'end';
  }, [dragTarget, hover, dragging, order, pane]);
  // The pane's × lit: its tabs show where they would go.
  const [leaving, setLeaving] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const fade = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    const f = stripFade(el.scrollLeft, el.scrollWidth, el.clientWidth);
    el.dataset.fade = [f.start && 'start', f.end && 'end'].filter(Boolean).join(' ');
  }, []);
  // The strip and every tab are watched: a tab that grows or shrinks (a new title, a late font) changes the fades. The
  // strip narrowing (a smaller window, a divider) keeps the tab in front whole if it was (keepInView).
  const sizes = useRef<ResizeObserver | null>(null);
  const revealed = useRef<TabKey | null>(null);
  const width = useRef<number | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const el = strip.current;
      if (el && entries.some((x) => x.target === el)) {
        const before = width.current;
        width.current = el.clientWidth;
        const tab = revealed.current ? el.querySelector<HTMLElement>(`.tab[data-key="${CSS.escape(revealed.current)}"]`) : null;
        const left = tab && before !== null ? keepInView({ left: tab.offsetLeft, width: tab.offsetWidth }, el.scrollLeft, before, el.clientWidth, REVEAL_PAD) : null;
        if (left !== null) el.scrollTo({ left, behavior: 'instant' });
      }
      fade();
    });
    sizes.current = ro;
    if (strip.current) ro.observe(strip.current);
    return () => { ro.disconnect(); sizes.current = null; };
  }, [fade]);
  // A vertical wheel scrolls the tabs sideways (non-passive: it replaces the page's own handling).
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    let goal: number | null = null;
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const move = wheelToStrip(e, el.clientWidth, document.documentElement.dataset.motion === 'reduced');
      if (!move) return;
      e.preventDefault();
      const plan = planWheel(move, goal, el.scrollLeft, max);
      goal = plan.goal;
      if (plan.to !== el.scrollLeft) el.scrollTo({ left: plan.to, behavior: plan.smooth ? 'smooth' : 'instant' });
    };
    const settle = () => { goal = null; };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scrollend', settle);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('scrollend', settle); };
  }, []);
  // The tab in front comes into view however it was brought there (sidebar, palette, shortcut, a newly opened tab, a
  // tab moved to the end), at once. A tab clicked comes whole into view too, its × in reach (a cut one had to be
  // wheeled into view to close it), gliding no farther than keeps the clicked point on it: the second click of a
  // double click lands on the same tab. `at`: the pointer from the strip's left edge.
  const pressed = useRef<{ key: string; at: number } | null>(null);
  const showClicked = useCallback((tab: HTMLElement, at: number | null) => {
    const el = strip.current;
    if (!el) return;
    const left = revealClicked({ left: tab.offsetLeft, width: tab.offsetWidth }, { scrollLeft: el.scrollLeft, width: el.clientWidth }, REVEAL_PAD, at);
    if (left !== null) el.scrollTo({ left, behavior: document.documentElement.dataset.motion === 'reduced' ? 'instant' : 'smooth' });
  }, []);
  useLayoutEffect(() => {
    const el = strip.current;
    const tab = front ? el?.querySelector<HTMLElement>(`.tab[data-key="${CSS.escape(front)}"]`) : null;
    const click = front !== revealed.current && front === pressed.current?.key ? pressed.current : null;
    revealed.current = front;
    pressed.current = null;
    if (el && tab && click) showClicked(tab, click.at);
    else if (el && tab) {
      const left = revealLeft({ left: tab.offsetLeft, width: tab.offsetWidth }, { scrollLeft: el.scrollLeft, width: el.clientWidth }, REVEAL_PAD);
      if (left !== null) el.scrollTo({ left, behavior: 'instant' });
    }
    if (el) for (const child of el.children) sizes.current?.observe(child);
    fade();
  }, [front, order, fade, showClicked]);
  // The tab already in front, clicked: nothing renders for it, so it is shown from here (from the keyboard, no pointer).
  const clickedFront = (e: MouseEvent<HTMLDivElement>) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab');
    if (!tab || tab.dataset.key !== front || e.altKey) return;
    pressed.current = null;
    showClicked(tab, e.detail ? e.clientX - e.currentTarget.getBoundingClientRect().left : null);
  };
  const byId = new Map(terminals.map((x) => [x.id, x]));
  const byPath = new Map(openFiles.map((f) => [f.path, f]));
  const connOf = (id: string) => conns.find((v) => v.conn.id === id)?.conn;
  const connName = (id: string) => connOf(id)?.name ?? '';
  const dbOf = (ref: DbTabRef): DbShown => { const c = connOf(ref.connId); return { kind: ref.kind, env: c ? envClass(c.env) : null, tip: dbTabTip(ref, connName) }; };
  const tabs = (
    <>
      {/* Its padding after the last tab takes a dropped tab, like "+" does. */}
      <div className="tab-strip" role="tablist" ref={strip} onScroll={fade} data-pane={pane}
        onPointerDown={(e) => { const key = (e.target as HTMLElement).closest<HTMLElement>('.tab')?.dataset.key; pressed.current = key ? { key, at: e.clientX - e.currentTarget.getBoundingClientRect().left } : null; }}
        onClick={clickedFront}>
      {order.map((k, i) => {
        const term = k.startsWith('t:') ? byId.get(k.slice(2)) : undefined;
        const file = k.startsWith('f:') ? byPath.get(k.slice(2)) : undefined;
        const rev = k.startsWith('rev:') ? revFiles.find((f) => f.key === k) : undefined;
        const table = k.startsWith('db:') ? dbTabs.find((r) => r.key === k) : undefined;
        const docker = k.startsWith('dk:') && dockerTabs.some((r) => r.key === k);
        const redisView = parseRedisKey(k);
        const auto = k.startsWith('au:') ? autoTabs.find((r) => r.key === k) : undefined;
        if (!term && !file && !rev && !table && !docker && !redisView && !auto && k !== 'services' && k !== 'review' && k !== 'history' && k !== 'background') return null;
        const tab = (
          <Tab key={k} k={k} active={k === front && focused} front={k === front && !focused} leaving={leaving} drop={dockBefore === k} lifted={dragging === k} term={term} starting={!!term && isStarting(term, starting)} file={file} svcErrors={serviceErrors} title={k === 'review' ? reviewTitle : k === 'background' ? backgroundTitle : k === 'history' ? historyTitle : docker ? dockerTitle(k) : redisView ? redisTabTitle(redisView) : auto ? autoTabTitle(auto.id, automations) : rev ? revTitle(rev) : table ? dbTabLabel(table, dbTabs, connName) : undefined}
            {...(redisView === 'queues' && failedJobs ? { badge: failedJobs } : {})}
            {...(table ? { db: dbOf(table) } : {})} />
        );
        return i === projectAt
          ? <Fragment key={k}><span className="tab-project" role="presentation" data-tip={t.ws.projectTip}><span className="tab-project-label">{t.ws.project}</span></span>{tab}</Fragment>
          : tab;
      })}
      </div>
      {/* "+": Sessions' new session or terminal; Redis's views (its strip has no switcher); the
          other spaces open from their sidebar. */}
      {space === 'sessions' && (
        <button type="button" className={`tab-new ${dockBefore === 'end' ? 'is-drop' : ''}`} aria-label={t.newMenu} data-tip={t.newMenu}
          onClick={(e) => { if (split) useApp.getState().focusPane(pane); onNew(e.currentTarget); }}>
          <Icon name="plus" size={14} />
        </button>
      )}
      {space === 'redis' && (
        <button type="button" className={`tab-new ${dockBefore === 'end' ? 'is-drop' : ''}`} aria-label={t.spaces.redisViews} data-tip={t.spaces.redisViews} aria-haspopup="menu"
          onClick={(e) => {
            const st = useApp.getState();
            if (split) st.focusPane(pane);
            const r = e.currentTarget.getBoundingClientRect();
            st.openMenu({ x: r.left, y: r.bottom + 4, anchor: { left: r.left, right: r.right, bottom: r.bottom } }, redisViewsMenu());
          }}>
          <Icon name="plus" size={14} />
        </button>
      )}
      {/* No "+" to carry it (Docker, Databases, Automations): the caret for the end of the strip on its own. */}
      {space !== 'sessions' && space !== 'redis' && dockBefore === 'end' && <span className="tab-end is-drop" aria-hidden="true" />}
      <span className="grow" />
      {split && <PaneTools pane={pane} onLeaving={setLeaving} />}
      {/* Changes belongs to Sessions. */}
      {last && space === 'sessions' && <ChangesToggle />}
    </>
  );
  if (!split) return tabs;
  // A press anywhere in the strip focuses its pane (its blank parts never take the keyboard from the pane's view); a
  // right-click on its empty part opens the pane's menu. The focused pane's strip is the current one for assistive tech.
  return (
    <div className={`pane-strip${focused ? ' is-focused' : ''}`} data-pane={pane} role="group" aria-label={t.split.paneN(pane + 1)} aria-current={focused || undefined}
      onMouseDown={keepPaneKeyboard}
      // The window's own controls in it (the Changes toggle, data-pane-keep) leave the focus where it is.
      onPointerDown={(e) => { if (!useApp.getState().tabDrag && !(e.target as HTMLElement).closest?.('[data-pane-keep]')) useApp.getState().focusPane(pane); }}
      onContextMenu={(e: MouseEvent) => { if (!e.defaultPrevented) useApp.getState().openMenu(e, paneMenu(pane)); }}>
      {tabs}
    </div>
  );
});

/** A pane's tools at the end of its strip: Split Right, then the × that unsplits it (its tabs move, nothing closes). */
function PaneTools({ pane, onLeaving }: { pane: number; onLeaving: (on: boolean) => void }) {
  const full = useApp((s) => s.split.panes.length >= MAX_PANES);
  const target = useApp((s) => { const x = unsplitTarget(s.split, pane); return x ? `${x.to}:${x.count}` : ''; });
  const [to, count] = target.split(':') as ['left' | 'right', string];
  const tip = t.split.unsplitTip(to ?? 'left', Number(count ?? 0));
  useEffect(() => () => onLeaving(false), [onLeaving]);
  return (
    <span className="tab-tools">
      <button type="button" className="sb-btn icon pane-split" aria-label={t.split.splitRight} aria-disabled={full || undefined}
        data-tip={full ? t.split.max : t.split.splitHint} data-kbd={full ? undefined : kbd('⌘\\')}
        onClick={() => { if (!full) useApp.getState().splitRight(); }}>
        <Icon name="split" size={13} stroke={1.8} />
      </button>
      <span className="pane-sep" aria-hidden="true" />
      <button type="button" className="sb-btn icon pane-close" aria-label={t.split.close} data-tip={tip}
        onPointerEnter={() => onLeaving(true)} onPointerLeave={() => onLeaving(false)} onFocus={() => onLeaving(true)} onBlur={() => onLeaving(false)}
        onClick={() => { onLeaving(false); useApp.getState().closePane(pane); }}>
        <Icon name="x" size={13} stroke={1.8} />
      </button>
    </span>
  );
}

/** Changes on and off, with how many files changed. */
function ChangesToggle() {
  const showChanges = useApp((s) => s.showChanges);
  const toggleChanges = useApp((s) => s.toggleChanges);
  // Workspaces on with This workspace: the count follows the filter.
  const changed = useApp((s) => (s.ws?.on && !s.popout && s.changesScope === 'ws' ? wsChangeCount(s.ws, s.repos, s.attributions) : s.repos.reduce((n, r) => n + r.changes.length, 0)));
  return (
    <button type="button" className={`changes-toggle ${showChanges ? 'is-on' : ''}`} onClick={toggleChanges} aria-label={t.toggleChanges} data-tip={t.changesTip} data-kbd={kbd('⌘⇧M')} data-pane-keep>
      <Icon name="git" size={14} />
      {changed > 0 && <span>{changed}</span>}
    </button>
  );
}
