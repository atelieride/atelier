import { Terminal, type IBufferRange } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { HoveredLink, claimClick, interceptLinkClicks, linkActivate, registerLinks } from './links';
import { blockJumpKey, claudeTakesKeys, copyKey, keyOverride, pasteKey, terminalFindKey } from './keys';
import { requestTerminalFind } from './find';
import { CommandBlocks } from './block-view';
import { copyText } from '../clipboard';
import { t } from '../i18n/en';
import { useApp } from '../store';
import { terminalOptions } from '../settings-apply';
import { BlinkIdle } from './blink-idle';
import type { Settings } from '@shared/settings';
import { isEditorOrPager, isShell } from '@shared/shells';
import { windowsPtyFor } from '@shared/windows-pty';
import { noteClaudePress, noteClaudeRelease } from './selection';
import { isClaudeTerminal, programTakesF10 } from './context-menu';
import { wheelLines } from './wheel';
import { setBracketedProbe, setOutputProbe, setTerminalFocuser } from './focus';
import { TriggerEngine, type TriggerWorkerLike } from './trigger-engine';
import { TriggerHighlights } from './trigger-view';
import { SnapshotFit } from './snapshot-fit';
import { withMouseEncoding } from './mouse-encoding';
import { sendInput } from './drafts';

/**
 * findMatch: where Find's current match was last selected, kept after its card closes: a selection
 * there is Find's, not the user's.
 */
/** unlink: stops what the terminal's links still follow (⌘ for a hovered outside link) once it is disposed. */
export interface LiveTerminal { term: Terminal; fit: FitAddon; findMatch?: IBufferRange; host: HTMLDivElement; attached: boolean; blocks: CommandBlocks; highlights: TriggerHighlights; snapshotFit: SnapshotFit; blink: BlinkIdle; unlink: () => void }

const live = new Map<string, LiveTerminal>();

// Output triggers: one engine for the window's terminals, matching in a worker.
const triggers = new TriggerEngine({
  makeWorker: () => new Worker(new URL('./triggers.worker.ts', import.meta.url), { type: 'module' }) as unknown as TriggerWorkerLike,
  kindOf: (id) => {
    const info = useApp.getState().terminals.find((x) => x.id === id);
    return info ? (info.session ? 'session' : 'terminal') : null;
  },
  onNotify: (id, rule, line) => {
    // The center entry through the store (like every other entry), then main decides the OS banner.
    if (useApp.getState().addTriggerNote(id, rule.pattern, line)) window.atelier.terminals.triggerMatched(id, rule.pattern, line);
  },
  onHighlight: (id, texts) => {
    const lt = live.get(id);
    // After the pending writes are parsed: the matched text is in the buffer by then.
    lt?.term.write('', () => lt.highlights.add(texts));
  },
  onSlow: (rule) => useApp.getState().showToast(t.triggers.paused(rule.pattern)),
  onBroken: (why) => useApp.getState().showToast(t.triggers.broken(why)),
  altScreen: (id) => live.get(id)?.term.buffer.active.type === 'alternate'
});
setTerminalFocuser((id) => live.get(id)?.term.focus());
setBracketedProbe((id) => bracketedPaste(id));
/** When each mounted terminal last received output: lets a typed Enter wait until a paste has been drawn. */
const lastOutput = new Map<string, number>();
setOutputProbe((id) => lastOutput.get(id) ?? 0);

/** The terminal's live xterm if it has one, never making one (a view of a terminal that just ended renders nothing). */
export function peekLiveTerminal(id: string): LiveTerminal | undefined {
  return live.get(id);
}

/** One xterm per terminal, created once and kept alive: switching tabs loses nothing. */
export function getLiveTerminal(id: string): LiveTerminal {
  let lt = live.get(id);
  if (lt) return lt;
  const hovered = new HoveredLink();
  const openOsc = (uri: string) => { useApp.getState().setLinkTip(null); void window.atelier.openUrl(uri); };
  // Windows: fed by ConPTY, so xterm doesn't reflow on a resize the way ConPTY doesn't expect (lines twice or lost).
  const windowsPty = windowsPtyFor(window.atelier.platform, window.atelier.osVersion);
  const term: Terminal = new Terminal({
    ...(windowsPty ? { windowsPty } : {}),
    letterSpacing: 0,
    cursorWidth: 2, cursorInactiveStyle: 'outline', allowProposedApi: true,
    drawBoldTextInBrightColors: false,
    // Find's ticks: the ruler is drawn over the scrollbar at its own width (xterm's 14 px), so
    // the fit addon finds the same columns; without matches it draws nothing.
    overviewRuler: { width: 14 },
    ...terminalOptions(useApp.getState().settings),
    // OSC 8 links (printed by programs): no native xterm confirm(), opened like any other URL (http/https only).
    linkHandler: {
      activate: (e, uri) => linkActivate(term, () => openOsc(uri))(e),
      // An OSC 8 link's text can say one thing and point elsewhere: the real destination is always shown.
      hover: (e, uri) => { hovered.hover(() => openOsc(uri)); useApp.getState().setLinkTip({ text: uri, x: e.clientX, y: e.clientY }); },
      leave: () => { hovered.leave(); useApp.getState().setLinkTip(null); },
      allowNonHttpProtocols: false
    }
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  const host = document.createElement('div');
  host.className = 'terminal-host';
  term.open(host);
  // The cursor rests 10 s after the last input, focus or click.
  const blink = new BlinkIdle({
    enabled: () => useApp.getState().settings.cursorBlink,
    set: (b) => { if (term.options.cursorBlink !== b) term.options.cursorBlink = b; },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  });
  host.addEventListener('focusin', () => blink.wake());
  host.addEventListener('mousedown', () => blink.wake());
  blink.wake();
  const unlink = registerLinks(term, id, hovered);
  interceptLinkClicks(host, term, hovered);
  // ⇧-right-click with the mouse captured (tmux, vim): Atelier's menu only, the program never sees the click (on macOS
  // xterm would still report it). Capture phase, before xterm's listeners; the contextmenu event still follows.
  // Full-screen Claude captures the mouse too, but has no right-click menu: the click is Atelier's alone, never reported
  // (it would clear Claude's selection); a left press there remembers the clipboard, to see what its drag copies.
  host.addEventListener('mousedown', (e) => {
    const tracking = term.modes.mouseTrackingMode !== 'none';
    const info = useApp.getState().terminals.find((x) => x.id === id);
    const claude = tracking && !!info && isClaudeTerminal({ foreground: info.foreground, session: !!info.session });
    // On macOS xterm selects the word under a right-click (read at the contextmenu that follows): over Claude's own
    // highlight that word would replace the selection Claude copied. Elsewhere it stays, as in Terminal.app.
    if (e.button === 2) term.options.rightClickSelectsWord = !claude;
    if (!tracking) return;
    if (e.button === 2 && (e.shiftKey || claude)) e.stopPropagation();
    if (e.button !== 0 || !claude) return;
    // The release may land outside the terminal (a drag past its edge): heard on the window, once.
    noteClaudePress(id, { x: e.clientX, y: e.clientY });
    window.addEventListener('mouseup', (up) => noteClaudeRelease(id, { x: up.clientX, y: up.clientY }), { once: true, capture: true });
  }, true);
  const blocks = new CommandBlocks(term, host, {
    copy: (text, what) => {
      if (what === 'output' && !text) { useApp.getState().showToast(t.blocks.noOutput, undefined, 'info'); return; }
      void copyText(text).then((ok) => { if (ok) useApp.getState().showToast(what === 'output' ? t.blocks.copiedOutput : t.blocks.copiedCommand, undefined, 'info'); });
    },
    words: t.blocks,
    nonce: () => useApp.getState().terminals.find((x) => x.id === id)?.markNonce,
    shellInFront: () => {
      const info = useApp.getState().terminals.find((x) => x.id === id);
      return !!info && isShell(info.foreground);
    }
  });
  blocks.setEnabled(useApp.getState().settings.commandBlocks);
  // Click to move the cursor: a plain click, released where it was pressed, in the command an
  // Atelier-profile zsh is waiting for. Decided at the release, before xterm's listeners: a link there doesn't open.
  host.addEventListener('mousedown', (down) => {
    if (down.button !== 0 || down.metaKey || down.altKey || down.shiftKey || down.ctrlKey) return;
    if (!useApp.getState().settings.clickMovesCursor || term.modes.mouseTrackingMode !== 'none') return;
    if (!(down.target as Element | null)?.closest?.('.xterm-screen')) return;
    window.addEventListener('mouseup', (up) => {
      if (up.button !== 0 || up.metaKey || up.altKey || up.shiftKey || up.ctrlKey) return;
      if (Math.abs(up.clientX - down.clientX) > 3 || Math.abs(up.clientY - down.clientY) > 3) return;
      if (term.hasSelection()) return;
      const keys = blocks.clickMove(up.clientX, up.clientY);
      if (keys === null) return;
      claimClick(up);
      if (keys) sendInput(id, keys);
    }, { once: true, capture: true });
  });
  // Automated tests use the DOM renderer, so the text is readable in the page.
  if (!navigator.webdriver) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* without WebGL the DOM renderer is used */ }
  }
  // The user's keys and pastes: followed for drafts (drafts.ts, the Session panel's guard), then sent.
  term.onData((data) => { blink.wake(); sendInput(id, data); });
  // Wheel with the mouse captured by a program: one event per line (see wheel.ts). Events created here
  // (isTrusted false) pass to xterm as they are, one per line.
  let wheelRest = 0;
  term.attachCustomWheelEventHandler((ev) => {
    if (!ev.isTrusted || term.modes.mouseTrackingMode === 'none' || ev.shiftKey || ev.deltaY === 0) return true;
    const screen = term.element?.querySelector('.xterm-screen');
    const cell = screen && term.rows ? screen.clientHeight / term.rows : 0;
    const r = wheelLines(wheelRest, ev.deltaY, ev.deltaMode, cell, term.rows);
    wheelRest = r.rest;
    const target = ev.target ?? screen;
    for (let i = 0; i < Math.abs(r.lines); i++) {
      target?.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(r.lines), deltaMode: 1, clientX: ev.clientX, clientY: ev.clientY, bubbles: true, cancelable: true }));
    }
    ev.preventDefault();
    return false;
  });
  term.attachCustomKeyEventHandler((e) => {
    // Claude in the foreground (claudeTakesKeys): a session with no editor in front, or Claude Code's own process.
    const info = useApp.getState().terminals.find((x) => x.id === id);
    // ⌘F (Ctrl+Shift+F on Windows): the terminal's find card, never a key for the program.
    const find = terminalFindKey(e);
    if (find) {
      e.preventDefault();
      if (find === 'find') requestTerminalFind(id);
      return false;
    }
    // ⌘↑/⌘↓ between command blocks: plain Atelier-profile terminals on their normal screen only (never a Claude
    // session, an editor or a pager in front).
    // Windows: Ctrl+C with a selection, Ctrl+Shift+C: copied, never sent to the program.
    const copy = copyKey(e, term.hasSelection());
    if (copy) {
      e.preventDefault();
      if (copy === 'copy' && term.hasSelection()) { void copyText(term.getSelection()); term.clearSelection(); }
      return false;
    }
    // Windows: Ctrl+V, Ctrl+Shift+V left to the browser (no preventDefault): its paste event is TerminalView's.
    if (pasteKey(e)) return false;
    const jump = blockJumpKey(e);
    if (jump && !info?.session && !isEditorOrPager(info?.foreground ?? '') && blocks.canJump()) {
      e.preventDefault();
      if (jump !== 'swallow') blocks.jump(jump);
      return false;
    }
    const o = keyOverride(!!info && claudeTakesKeys({ foreground: info.foreground, session: !!info.session }), e, term.modes.applicationCursorKeysMode);
    if (!o) return true;
    if (o.send) { e.preventDefault(); sendInput(id, o.send); }
    return false;
  });
  lt = { term, fit, host, attached: false, blocks, highlights: new TriggerHighlights(term), snapshotFit: new SnapshotFit(), blink, unlink };
  live.set(id, lt);
  return lt;
}

/** Settings changed: they apply at once to all open terminals (the visible terminal then refits). */
export function applyTerminalSettings(s: Settings): void {
  triggers.setRules(s.triggers);
  const o = terminalOptions(s);
  for (const lt of live.values()) {
    lt.blocks.setEnabled(s.commandBlocks);
    for (const [k, v] of Object.entries(o)) {
      // The blink is the idle controller's: the setting only says whether the cursor blinks while you work.
      if (k === 'cursorBlink') continue;
      if ((lt.term.options as Record<string, unknown>)[k] !== v) (lt.term.options as Record<string, unknown>)[k] = v;
    }
    lt.blink.settingsChanged(s.cursorBlink);
  }
}

export function disposeLiveTerminal(id: string): void {
  const lt = live.get(id);
  triggers.dispose(id);
  if (!lt) return;
  lt.blink.dispose();
  lt.highlights.dispose();
  lt.unlink();
  lt.term.dispose();
  lt.host.remove();
  live.delete(id);
  lastOutput.delete(id);
}

/** Full screen (first attach or reconnection): replaces the one shown. */
export function resetTerminal(id: string, snapshot: string): void {
  const lt = live.get(id);
  if (!lt) return;
  // The snapshot carries no command marks: blocks start over from here.
  lt.blocks.reset();
  // Nor is it new output: triggers never see it (only what follows), and its old highlights are gone with the screen.
  triggers.snapshot(id, snapshot);
  lt.highlights.dispose();
  lt.term.reset();
  const info = useApp.getState().terminals.find((x) => x.id === id);
  lt.term.write(withMouseEncoding(snapshot, !!info && isClaudeTerminal({ foreground: info.foreground, session: !!info.session })));
  // A shell may have drawn its prompt before the attach and said nothing since: the snapshot is that output (a new
  // terminal waits for it before typing, send-selection.ts).
  if (snapshot) lastOutput.set(id, Date.now());
  // Written at this size: the next fit asks for it again if the pane is another size (see SnapshotFit).
  lt.snapshotFit.written(lt.term.cols, lt.term.rows);
}

/**
 * View › Redraw Terminal: the screen asked again from atelierd (as a restart would), for a view out of step with it.
 * Its command blocks start over (see resetTerminal).
 */
export function redrawTerminal(id: string): void {
  if (live.get(id)?.attached) void window.atelier.terminals.attach(id).catch(() => {});
}

/** The terminal holding `el` (the focused element) runs a full-screen program that wants F10 (htop, mc). */
export function terminalTakesF10(el: Element | null): boolean {
  if (!el) return false;
  for (const [id, lt] of live) {
    if (!lt.host.contains(el)) continue;
    const info = useApp.getState().terminals.find((x) => x.id === id);
    return programTakesF10({ alternate: lt.term.buffer.active.type === 'alternate', mouseTracking: lt.term.modes.mouseTrackingMode !== 'none', foreground: info?.foreground ?? '', session: !!info?.session });
  }
  return false;
}

/** Has the foreground program enabled bracketed paste? (Claude and zsh do.) */
export function bracketedPaste(id: string): boolean {
  return live.get(id)?.term.modes.bracketedPasteMode ?? false;
}

/** Command blocks of a terminal, when it has any to act on (an Atelier-profile shell on its normal screen). */
export function commandBlocks(id: string): CommandBlocks | null {
  const b = live.get(id)?.blocks;
  return b?.canJump() ? b : null;
}

/** New output of a terminal: shown, and matched by the output triggers (mounted terminals only). */
export function writeToTerminal(id: string, data: string): void {
  const lt = live.get(id);
  if (!lt) return;
  lastOutput.set(id, Date.now());
  lt.term.write(data);
  triggers.data(id, data);
}
