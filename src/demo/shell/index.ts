import type { AtelierApi, MenuCommand } from '@shared/api';
import type { TerminalInfo } from '@shared/protocol';
import { MENU_SPEC } from '@shared/menu-spec';
import type { Settings } from '@shared/settings';
import type { DemoBridge } from '../bridge';
import { NOT_IN_DEMO_EVENT } from '../bridge/not-in-demo';
import { demoMessage, type DemoKey, type DemoView } from '../protocol';
import type { DemoWorld } from '../types';
import { documentVisibility, visibleTimeout } from '../visible-timeout';
import { acceleratorMap, isMacPlatform, matchBinding } from './accelerators';
import { createChannel, fromParent } from './channel';
import { actionFor, checklistContext, initialChecklist, progress, reduceChecklist, type ChecklistId, type ChecklistSignal } from './checklist';
import { createChecklistView } from './checklist-view';
import { showCoach } from './coach';
import { h } from './dom';
import type { EditOp, MenuEffect } from './effects';
import { createLights } from './lights';
import { checklistPlace } from './make-way';
import { createMenubar } from './menubar';
import { buildMenus, demoMenuEnv, DOWNLOAD_HREF } from './menu-model';
import { MAKES_WAY, observeApi } from './observe';
import { openSteps } from './open-view';
import { createReservedWatcher } from './reserved';
import { SCREEN_WATCH_MS, watchScreen } from './screen-watch';
import { createToast } from './toast';
import './shell.css';
import type { MenuState } from '@shared/api';

// The demo shell: a small Mac around the real renderer, in
// the iframe's own document. The menu bar and the accelerators from the menu definition, the traffic lights, "Things
// to try", the first hint, the notices, and the messages with the page. It never reaches into the app: it sends the
// commands the native menu sends, and watches the bridge from outside (observe.ts) and the screen.

/** Startup budget, in visible time, before the page is told the demo failed (the page itself gives up at 10 s). */
const STARTUP_MS = 8000;
/** The first real frame: a session row in the sidebar (the store has the world, React has painted it). */
const FIRST_FRAME = '.session-row';
/** Two panes or more on screen. */
const SPLIT = '.workspace-body.is-split';
/** A JSON file's tree on screen (Tree or Split). */
const JSON_TREE = '.file-view:not([style*="none"]) .json-tree';
/** A Databases value open in the JSON view, read (the inspector's place; its body once parsed). */
const DB_JSON = '.dbj .dbj-body';
/** The Changes panel. */
const CHANGES = 'aside.changes';
/** The session in front waits for the visitor. */
const SELECTED_WAITING = '.session-row.is-selected.state-waiting';
/** The selected session's name in the sidebar. */
const SELECTED_TITLE = '.session-row.is-selected .session-title';
/** An Ask panel on screen (`data-terminal` names its terminal). */
const ASK = 'aside.ask';

const EDIT: Record<EditOp, { command: string; keys?: string; label: string }> = {
  undo: { command: 'undo', keys: '⌘Z', label: 'Undo' },
  redo: { command: 'redo', keys: '⌘⇧Z', label: 'Redo' },
  cut: { command: 'cut', keys: '⌘X', label: 'Cut' },
  copy: { command: 'copy', keys: '⌘C', label: 'Copy' },
  paste: { command: 'paste', keys: '⌘V', label: 'Paste' },
  pasteAndMatchStyle: { command: 'paste', keys: '⌘⌥⇧V', label: 'Paste and Match Style' },
  delete: { command: 'delete', label: 'Delete' },
  selectAll: { command: 'selectAll', keys: '⌘A', label: 'Select All' }
};

/** Builds the shell around the page and returns the bridge as the renderer gets it (observed). */
export function installShell(demo: DemoBridge, world: DemoWorld): AtelierApi {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string }; keyboard?: { lock?(keys?: string[]): Promise<void> } };
  const mac = isMacPlatform(nav);
  const chromium = typeof nav.keyboard?.lock === 'function';
  const embedded = window.parent !== window;
  const html = document.documentElement;
  html.classList.add('dm-shell');

  const layer = h('div', { class: 'dm-layer' });
  document.body.append(layer);
  const toast = createToast(layer);

  // ——— Where the visitor was: the focus goes back there after a menu, or when the page hands the focus back.
  let lastFocus: HTMLElement | null = null;
  document.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    if (!layer.contains(t)) lastFocus = t;
  });
  const visibleTerminal = () => [...document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea')].find((t) => (t.closest('.xterm') as HTMLElement | null)?.getClientRects().length);
  const restoreFocus = () => {
    const target = lastFocus?.isConnected && lastFocus !== document.body ? lastFocus : visibleTerminal();
    target?.focus({ preventScroll: true });
  };

  // ——— Full screen: the page owns the iframe element, so it is asked; the demo follows whatever happens.
  const topDoc = (): Document | null => { try { return window.top?.document ?? null; } catch { return null; } };
  const isFullscreen = () => !!(topDoc() ?? document).fullscreenElement;
  const exitFullscreen = () => { void (topDoc() ?? document).exitFullscreen?.().catch(() => { /* already out */ }); };
  const lockKeys = async () => {
    // ⌘W, ⌘T, ⌘N, ⌘1–9 for the app while in full screen (Chromium). Chromium allows the lock in a top-level document
    // only: the demo's own first, then the page's (same origin). Refused or missing: nothing to say.
    for (const n of [nav, (() => { try { return window.top?.navigator as typeof nav | undefined; } catch { return undefined; } })()]) {
      try { if (n?.keyboard?.lock) { await n.keyboard.lock(); return; } } catch { /* next */ }
    }
  };

  // ——— The page.
  const channel = createChannel({
    embedded,
    post: (m) => window.parent.postMessage(demoMessage(m), location.origin),
    // The page's `pause` (the demo closed, its iframe kept but display none, where document.hidden stays false) stops
    // the demo's clock: the engine, the shell's screen watch, every stream the bridge plays. The renderer's own timers
    // (unchanged app code) keep running: with no data arriving and nothing displayed they find nothing to do.
    pause: () => demo.context.clock.pause(),
    resume: () => demo.context.clock.resume(),
    focus: () => { window.focus(); restoreFocus(); },
    key: (k: DemoKey) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true, composed: true }));
    },
    open: (view) => openView(view, false),
    leave: () => location.assign('/'),
    requestFullscreen: () => { void html.requestFullscreen?.().catch(() => { /* refused */ }); }
  });
  addEventListener('message', (e) => { if (fromParent(e, { origin: location.origin, parent: embedded ? window.parent : undefined })) channel.receive(e.data); });

  // ——— Things to try.
  const ctx = checklistContext(world);
  let check = initialChecklist(ctx);
  const view = createChecklistView(layer, { pick: (id) => showMe(id) });
  view.render(check);
  const signal = (sig: ChecklistSignal) => {
    const next = reduceChecklist(check, sig, ctx);
    if (next === check) return;
    const ticked = next.done.size !== check.done.size;
    check = next;
    if (!ticked) return;
    view.render(check);
    const p = progress(check);
    channel.checklist(p.done, p.total);
  };
  // The sessions as main last sent them (whose background is worth opening).
  let terminals: readonly TerminalInfo[] = world.sessions.map((s) => s.terminal);
  demo.events.on.terminals((list) => { terminals = list; signal({ kind: 'terminals', list }); });
  // Before the renderer's own listener (the shell is installed first): a look the renderer makes because a container
  // just stopped (Inspect re-reads it) already finds it stopped.
  demo.events.on.docker((snap) => signal({ kind: 'containers', list: snap.containers }));
  // The list makes way for the Changes panel (make-way.ts: above its commit bar, left of it with the drawer open):
  // measured on the demo's clock, and right after every command the shell sends (⌘⇧M, ⌥⌘K, an item's click).
  const makeWay = () => {
    const panel = document.querySelector(CHANGES)?.getBoundingClientRect();
    // The right-most Ask panel on screen (its composer and Send sit bottom right, under the list's usual place).
    const ask = [...document.querySelectorAll(ASK)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => b.right - a.right)[0];
    view.place(checklistPlace({
      changes: panel ? { left: panel.left, width: panel.width } : null,
      barTop: document.querySelector(`${CHANGES} .git-bar`)?.getBoundingClientRect().top ?? null,
      drawer: !!document.querySelector(`${CHANGES} .git-drawer`),
      width: document.documentElement.clientWidth, height: document.documentElement.clientHeight,
      ask: ask ? { left: ask.left, width: ask.width } : null
    }));
  };
  makeWay();
  demo.context.clock.every(SCREEN_WATCH_MS, makeWay);
  /** An item's "show me" (checklist.ts actionFor): what it opens; the usual detection ticks it. */
  function showMe(id: ChecklistId) {
    const a = actionFor(id, check, ctx, {
      split: !!document.querySelector(SPLIT),
      changes: !!document.querySelector(CHANGES),
      selectedWaiting: !!document.querySelector(SELECTED_WAITING) && !!visibleTerminal(),
      jsonTree: !!document.querySelector(JSON_TREE),
      dbJson: !!document.querySelector(DB_JSON),
      workspaces: !!document.querySelector('.ws-head')
    });
    if (!a) return;
    switch (a.kind) {
      case 'command': openView(a.command); break;
      case 'view': openView(a.view); break;
      case 'docker': if (a.crash) demo.beats.crashWorker(); demo.events.emit('dockerOpen', a.id); break;
      case 'redis': demo.events.emit('redisOpen', a.queue); break;
      case 'hint': break;
    }
    if (a.hint) toast.show({ text: a.hint }, 6000);
    // From the keyboard (Enter on an item), the focus is on it: once the app has put it somewhere (the palette's input,
    // a terminal), that stands; otherwise it goes back where the visitor was.
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (!el || el === document.body || layer.contains(el)) restoreFocus();
    });
  }
  // On screen, whoever opened it (a click on the header's search, F1, Alt-click "open to the side"). On the demo's
  // clock: paused with the rest of the world.
  watchScreen(demo.context.clock, () => {
    if (document.querySelector('.palette')) signal({ kind: 'dom', what: 'palette' });
    if (document.querySelector(SPLIT)) signal({ kind: 'dom', what: 'split' });
    if (document.querySelector(JSON_TREE)) signal({ kind: 'dom', what: 'json-tree' });
    if (document.querySelector(DB_JSON)) signal({ kind: 'dom', what: 'db-json' });
    return check.done.has('search') && check.done.has('split') && check.done.has('json') && check.done.has('databases');
  });

  /** A view, as a feature row's "Try it" or a "Things to try" item opens it (open-view.ts). */
  function openView(view: DemoView, visitor = true) {
    const backdrop = document.querySelector('.palette-backdrop');
    const steps = openSteps(view, {
      split: !!document.querySelector(SPLIT), terminals,
      selected: document.querySelector(SELECTED_TITLE)?.textContent ?? null,
      sheet: backdrop ? (backdrop.querySelector('.new-session') ? 'new-session' : 'other') : null
    });
    for (const step of steps) {
      // Every sheet closes on a press on its backdrop (onMouseDown), as a click outside it.
      if (step.kind === 'close-sheet') backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      else if (step.kind === 'select') demo.events.emit('select', step.id);
      else if (step.kind === 'open-file') {
        const path = `${world.project.root}/${step.rel}`;
        demo.events.emit('openPaths', { files: [{ path, rel: step.rel, external: false }], reveal: null, skipped: 0, capped: null, needsProject: 0 });
      } else if (step.kind === 'ask') {
        // Once the select is drawn: ⌘I's command opens Ask there, unless its panel shows already (⌘I would close it).
        const shown = () => !!document.querySelector(`${ASK}[data-terminal="${CSS.escape(step.id)}"]`);
        requestAnimationFrame(() => requestAnimationFrame(() => { if (!shown()) command('ask-session', visitor); }));
      } else command(step.command, visitor);
    }
  }

  // ——— What menus and keys do.
  /** A command to the renderer, exactly as the native menu sends it. `visitor`: counts for the checklist (the page's
   *  `open` doesn't). */
  function command(cmd: MenuCommand, visitor = true) {
    if (visitor) signal({ kind: 'command', command: cmd });
    demo.events.emit('command', cmd);
    requestAnimationFrame(() => requestAnimationFrame(makeWay));
  }
  const exit = () => { if (isFullscreen()) exitFullscreen(); channel.exit(); };
  const fullscreen = () => { if (isFullscreen()) exitFullscreen(); else channel.fullscreen(); };
  function edit(op: EditOp) {
    const e = EDIT[op];
    let ok = false;
    try { ok = document.execCommand(e.command); } catch { ok = false; }
    if (!ok) toast.show({ text: e.keys ? `Press ${e.keys}: your browser keeps ${e.label} for the keyboard.` : `Your browser keeps ${e.label} for the keyboard.` });
  }
  function run(effect: MenuEffect) {
    switch (effect.kind) {
      case 'command': command(effect.command); break;
      case 'not-in-demo': window.dispatchEvent(new CustomEvent(NOT_IN_DEMO_EVENT, { detail: { what: effect.what } })); break;
      case 'exit': exit(); break;
      case 'fullscreen': fullscreen(); break;
      case 'edit': edit(effect.op); break;
      case 'licenses': void demo.api.openLicenses(); break;
      case 'link': window.open(effect.href, '_top'); break;
      case 'checklist': view.show(); break;
    }
  }

  // The Claude accounts as the settings have them, as main rebuilds its menu: an account added, renamed or removed in
  // the demo's Settings shows in File › New Session with Account. The bar reads a menu's items when it opens it.
  // Workspaces too: the page tells the bridge its menu state as it tells main (menuState below),
  // and Go lists them, File shows New Workspace…, while they are on.
  let workspacesMenu: MenuState['workspaces'];
  let settingsNow = demo.context.state.settings;
  const menusFor = (s: Settings) => buildMenus(MENU_SPEC, demoMenuEnv(s, workspacesMenu));
  const menus = menusFor(settingsNow);
  demo.events.on.settings((s) => { settingsNow = s; menus.splice(0, menus.length, ...menusFor(s)); });
  const menubar = createMenubar(layer, { menus, run, restoreFocus, isFullscreen, exit });
  const lights = createLights(layer, { exit, minimize: exit, fullscreen });
  const onFullscreenChange = () => {
    const on = isFullscreen();
    lights.setFullscreen(on);
    html.classList.toggle('dm-fullscreen', on);
    if (on) void lockKeys();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  try { if (embedded) topDoc()?.addEventListener('fullscreenchange', onFullscreenChange); } catch { /* another origin: never here */ }

  addEventListener(NOT_IN_DEMO_EVENT, () => toast.show({ text: 'This one runs on your Mac.', link: { label: 'Download Atelier', href: DOWNLOAD_HREF }, after: ' to try it.' }));

  // ——— The keyboard: the menu bar first, then the menu's accelerators, before the renderer's own listeners (this
  // listener is added before any of them: install.ts runs before the renderer's modules). In the app the page sees a
  // key before the native menu; why the demo's order gives the same outcome: accelerators.ts.
  const bindings = acceleratorMap(MENU_SPEC, mac);
  const reserved = createReservedWatcher({ mac, chromium, now: () => performance.now() });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    reserved.keydown(e);
    if (menubar.onKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === 'F2' && e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopImmediatePropagation(); menubar.focus(); return; }
    const b = matchBinding(bindings, e, mac);
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    run(b.effect);
  }, true);

  const comeBack = () => { const msg = reserved.back(); if (msg) toast.show({ text: msg }, 6000); };
  document.addEventListener('visibilitychange', () => {
    channel.visibility(document.hidden);
    if (document.hidden) reserved.left('hidden'); else comeBack();
  });
  addEventListener('blur', () => reserved.left('blur'));
  addEventListener('focus', comeBack);

  // ——— Startup: `ready` once the first real frame is on screen; `failed` on an error before it, or too long.
  const fail = (reason: string) => { if (!channel.isReady) channel.fail(reason); };
  const onError = (e: ErrorEvent) => { if (!/ResizeObserver loop/.test(e.message)) fail(e.message || 'script error'); };
  const onRejection = (e: PromiseRejectionEvent) => fail(String((e.reason as Error | undefined)?.message ?? e.reason ?? 'unhandled rejection'));
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onRejection);
  // Visible time only: a demo opened into a background tab has its frames stalled until the visitor looks at it.
  const watchdog = visibleTimeout(STARTUP_MS, () => fail(`no first frame after ${STARTUP_MS / 1000} s`), documentVisibility(document));
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const painted = () => new Promise<void>((resolve) => {
    if (document.querySelector(FIRST_FRAME)) { resolve(); return; }
    const mo = new MutationObserver(() => { if (document.querySelector(FIRST_FRAME)) { mo.disconnect(); resolve(); } });
    mo.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true });
  });
  void painted().then(() => document.fonts.ready).then(frame).then(() => {
    watchdog();
    removeEventListener('error', onError);
    removeEventListener('unhandledrejection', onRejection);
    if (channel.isReady) return;
    channel.ready();
    if (!embedded) restoreFocus();
    showCoach(layer);
  });

  const api = observeApi(demo.api, (name, args) => {
    signal({ kind: 'call', name, args });
    // Ask just opened or asked: the list makes way for the panel at once (once it is drawn), not at the next look.
    if (MAKES_WAY.includes(name)) requestAnimationFrame(() => requestAnimationFrame(makeWay));
  });
  // The page's menu state, as main hears it: the menu bar follows the workspaces; "Things to try" sees a switch.
  return {
    ...api,
    menuState: (s: MenuState) => {
      const ws = s.workspaces;
      if (JSON.stringify(ws) !== JSON.stringify(workspacesMenu)) {
        workspacesMenu = ws;
        menus.splice(0, menus.length, ...menusFor(settingsNow));
      }
      signal({ kind: 'call', name: 'menuState', args: [s] });
      api.menuState(s);
    }
  };
}
