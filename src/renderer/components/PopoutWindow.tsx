import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { imageMime, videoMime } from '@shared/files';
import { isWaiting } from '@shared/session-view';
import { TerminalView } from '../terminal/TerminalView';
import { FileView } from '../editor/FileView';
import { ImageView } from '../editor/ImageView';
import { VideoView } from '../editor/VideoView';
import { ServicesView } from './ServicesView';
import { ReviewView } from './ReviewView';
import { HistoryView } from '../scm/HistoryView';
import { RevFileView } from '../scm/RevFileView';
import { RefPicker } from '../scm/RefPicker';
import { BackgroundView } from './background/BackgroundView';
import { DockerView } from '../docker/DockerView';
import { RedisView } from '../redis/RedisView';
import { parseRedisKey } from '../redis/tabs';
import { RedisSheets, UndoPill } from '../redis/RedisSheets';
import { ErrorBoundary } from './ErrorBoundary';
import { SessionBar } from './SessionBar';
import { PaneHeader, useTabTitle } from './PaneHeader';
import { ContextMenu } from './ContextMenu';
import { BackgroundPopover } from './BackgroundPopover';
import { Tooltip } from './Tooltip';
import { Toast } from './Toast';
import { DropPill } from './DropPill';
import { SaveAsSheet } from './SaveAsSheet';
import { LanguageSheet } from './LanguageSheet';
import { Icon } from './Icon';
import { DictationPill } from '../dictation/DictationPill';
import { isStarting } from '../starting';
import { isUntitled } from '../untitled';
import { dragBackEnd, moveBack, pastThreshold } from '../popout-actions';
import { popoutBarMenu } from '../menus';
import type { Point } from '@shared/popout';
import type { TabKey } from '../tabs-model';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { DbSheetsHost } from '../databases/DbSheetsHost';
import { currentPlatform } from '@shared/platform';
import { kbd } from '../kbd';
import { Confirms } from '../confirms/Confirms';
import { AskHost } from './companion/AskHost';
import { ASK_INSET } from './companion/inset';
import { sheetIn } from '../companion/view';

// Their own chunks, as in the project window (App.tsx), out of the first paint (the live demo's budget): a table tab's
// view, and Automations' — a static import here kept it in the first paint for every window.
const DbTabView = lazy(() => import('../databases/DbTabView').then((m) => ({ default: m.DbTabView })));
// As in the project window: "Who changed this?" loads when it opens (the live demo's budget).
const OriginSheet = lazy(() => import('./OriginSheet').then((m) => ({ default: m.OriginSheet })));

/**
 * A tab in a window of its own: a slim bar — traffic lights, the handle that drags it back, the
 * tab's own header (a session's bar, else the pane header), Move Back — over the tab's view, focused.
 */
export function PopoutWindow() {
  const key = useApp((s) => s.popout?.key ?? '') as TabKey;
  const projectName = useApp((s) => s.project?.name ?? '');
  // Its one tab, while there is something to show (a terminal that ended: nothing, main closes the window).
  const alive = useApp((s) => s.tabOrder.includes(key));
  const term = useApp((s) => (key.startsWith('t:') ? s.terminals.find((x) => x.id === key.slice(2)) : undefined));
  const starting = useApp((s) => !!term && isStarting(term, s.starting));
  const title = useTabTitle(key);
  const saveAsPath = useApp((s) => s.saveAs?.path ?? null);
  const languageSheet = useApp((s) => s.languageSheet);
  const originSheet = useApp((s) => s.originSheet);
  const refPicker = useApp((s) => s.refPicker !== null);
  const pastedAt = useApp((s) => s.pastedAt);
  // So Mission Control, the Window menu and ⌘` read it well.
  useEffect(() => { document.title = title ? `${title} — ${projectName}` : projectName; }, [title, projectName]);
  const session = !!term && (!!term.session || starting);
  // Ask moves with its pane: docked or a sheet inside the pop-out too.
  const askDocked = useApp((s) => !!term && s.askDock[term.id] === 'dock');
  const askSheet = useApp((s) => sheetIn(s, key));
  return (
    <div className="popout">
      {/* Right-click or Shift+F10 on the bar: Move Back and the tab's own items (a chip's own menu comes first). */}
      <div className="popout-bar" onContextMenu={(e) => { if (!e.defaultPrevented) useApp.getState().openMenu(e, popoutBarMenu(key)); }}>
        {currentPlatform() !== 'win32' && <div className="traffic-space" />}
        <PopoutHandle />
        {alive && (session && term ? <SessionBar term={term} popout /> : <PaneHeader k={key} popout />)}
        {!alive && <span className="grow" />}
        <button type="button" className="sb-btn popout-back" aria-label={t.popout.moveBack} data-tip={t.popout.moveBackTip} data-kbd={kbd('⌘W')} onClick={() => void moveBack()}>
          <Icon name="dock" size={13} stroke={1.8} /><span>{t.popout.moveBack}</span>
        </button>
        {currentPlatform() === 'win32' && <div className="caption-space" />}
      </div>
      <div className={`workspace-body popout-body${isWaiting(term?.session) ? ' is-waiting' : ''}`} style={askDocked ? ASK_INSET : undefined}>
        {alive && <PopoutView k={key} />}
        {alive && term && <AskHost terminalId={term.id} />}
        {pastedAt && key.startsWith('t:') && <div className={`paste-toast${askSheet ? ' is-left' : ''}`}><i />{t.pasted}</div>}
        <DictationPill />
      </div>
      <ContextMenu />
      <BackgroundPopover />
      <Tooltip />
      <DropPill />
      <Toast />
      <UndoPill />
      <RedisSheets />
      {saveAsPath && <SaveAsSheet key={saveAsPath} path={saveAsPath} />}
      {languageSheet && <LanguageSheet key={languageSheet} path={languageSheet} />}
      {originSheet && <Suspense fallback={null}><OriginSheet key={originSheet} path={originSheet} /></Suspense>}
      {refPicker && <RefPicker />}
      {/* A table tab's connection sheets (Edit Connection… from its problem), as in the project window. */}
      <DbSheetsHost />
      <Confirms />
    </div>
  );
}

/** The tab's view, shown and focused, inside its error boundary exactly as the main window renders it. */
function PopoutView({ k }: { k: TabKey }) {
  const termId = k.startsWith('t:') ? k.slice(2) : null;
  const hasTerm = useApp((s) => termId !== null && s.terminals.some((x) => x.id === termId));
  const file = useApp((s) => (k.startsWith('f:') ? s.openFiles.find((f) => f.path === k.slice(2)) : undefined));
  const rev = useApp((s) => (k.startsWith('rev:') ? s.revFiles.find((f) => f.key === k) : undefined));
  const table = useApp((s) => (k.startsWith('db:') ? s.dbTabs.find((r) => r.key === k) : undefined));
  const services = useApp((s) => k === 'services' && s.servicesOpen);
  const review = useApp((s) => k === 'review' && s.review !== null);
  const history = useApp((s) => k === 'history' && s.historyTab !== null);
  const background = useApp((s) => k === 'background' && s.backgroundTab !== null);
  const docker = useApp((s) => (k.startsWith('dk:') ? s.dockerTabs.find((r) => r.key === k) : undefined));
  const redis = useApp((s) => { const v = parseRedisKey(k); return v && s.redisTabs.includes(v) ? v : null; });
  if (termId !== null) return hasTerm ? <ErrorBoundary id="terminal" panel={t.crashPanels.terminal} visible><TerminalView key={termId} id={termId} visible focused /></ErrorBoundary> : null;
  if (file) {
    return (
      <ErrorBoundary key={file.path} id="editor" panel={t.crashPanels.editor} visible>
        {imageMime(file.path) && !isUntitled(file.path) ? <ImageView file={file} visible />
          : videoMime(file.path) && !isUntitled(file.path) ? <VideoView file={file} visible /> : <FileView file={file} visible focused />}
      </ErrorBoundary>
    );
  }
  if (rev) return <ErrorBoundary key={rev.key} id="rev-file" panel={t.crashPanels.revFile} visible><RevFileView file={rev} visible focused /></ErrorBoundary>;
  if (table) return <ErrorBoundary key={table.key} id="databases" panel={t.crashPanels.databases} visible><Suspense fallback={null}><DbTabView tab={table} visible focused /></Suspense></ErrorBoundary>;
  if (services) return <ErrorBoundary id="services" panel={t.crashPanels.services} visible><ServicesView visible focused /></ErrorBoundary>;
  if (review) return <ErrorBoundary id="review" panel={t.crashPanels.review} visible><ReviewView visible focused /></ErrorBoundary>;
  if (history) return <ErrorBoundary id="history" panel={t.crashPanels.history} visible><HistoryView visible focused /></ErrorBoundary>;
  if (background) return <ErrorBoundary id="background" panel={t.crashPanels.background} visible><BackgroundView visible focused /></ErrorBoundary>;
  if (docker) return <ErrorBoundary id="docker" panel={t.crashPanels.docker} visible><DockerView tab={docker} visible focused /></ErrorBoundary>;
  if (redis) return <ErrorBoundary id="redis" panel={t.crashPanels.redis} visible><RedisView view={redis} visible focused /></ErrorBoundary>;
  return null;
}

/**
 * The handle: pressing it and dragging moves the window with the pointer (main follows the cursor),
 * and releasing over the main window docks the tab there; Esc puts the window back where it started. The rest of the
 * bar moves the window natively and never docks. A press that never moved (a click) ends without the tab's buffer.
 * Out of the Tab order: Move Back is the keyboard's way.
 */
function PopoutHandle() {
  const dragging = useRef(false);
  const start = useRef<Point>({ x: 0, y: 0 });
  const moved = useRef(false);
  const [active, setActive] = useState(false);
  const finish = (dock: boolean, at?: Point) => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    // Where it was released counts too (main counts the same cursor): a drag never ends without the buffer.
    if (dock) void dragBackEnd(moved.current || (at !== undefined && pastThreshold(start.current, at)));
    else void window.atelier.popout.dragCancel().catch(() => {});
  };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || dragging.current) return;
    // The keyboard stays in the tab's view (a press on a button would take it).
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    start.current = { x: e.screenX, y: e.screenY };
    moved.current = false;
    setActive(true);
    void window.atelier.popout.dragStart().catch(() => {});
  };
  // Screen coordinates: the window moves under the pointer while it drags.
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging.current && !moved.current && pastThreshold(start.current, { x: e.screenX, y: e.screenY })) moved.current = true;
  };
  return (
    <button type="button" tabIndex={-1} className={`popout-handle${active ? ' is-dragging' : ''}`} aria-label={t.popout.handle} data-tip={active ? undefined : t.popout.handle}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(e) => finish(true, { x: e.screenX, y: e.screenY })} onLostPointerCapture={(e) => finish(true, { x: e.screenX, y: e.screenY })} onPointerCancel={() => finish(false)}>
      <Icon name="grip" size={14} stroke={2.6} />
    </button>
  );
}
