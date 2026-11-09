import { useEffect, useRef, useState, type CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import { bracketedPaste, getLiveTerminal } from './registry';
import { attachWithRetry, type PendingAttach } from './attach-retry';
import { useApp } from '../store';
import { t } from '../i18n/en';
import { terminalMenu } from '../menus';
import { copyText } from '../clipboard';
import { clipboardPayload, copiedFilesText, pasteSequence } from './paste';
import { sendInput } from './drafts';
import { folderName } from '../reveal';
import { claudeSelectionOf, cleanSelection } from './selection';
import { textInNewTerminal } from '../send-selection';
import { atelierMenuOnRightClick } from './context-menu';
import { TREE_PATH_TYPE, dropText, endTreeDrag, treeDragPath } from './drop';
import { profileShellKind } from '@shared/shell-kind';
import { onTerminalFind, requestTerminalFind } from './find';

// Find in the terminal: the card and xterm's search addon are a chunk of their own, never in the
// first paint (the app's nor the live demo's), fetched once the first terminal is up and the page is idle. Kept here
// once loaded, so the first ⌘F renders the card in the same pass (no suspense): what is typed right after it reaches
// the card, not the program.
type FindModule = typeof import('./TerminalFind');
let findModule: FindModule | null = null;
let findLoading: Promise<FindModule> | null = null;
function loadFind(): Promise<FindModule> {
  findLoading ??= import('./TerminalFind').then((m) => (findModule = m)).catch((e: unknown) => { findLoading = null; throw e; });
  return findLoading;
}
function prefetchFind() {
  if (findLoading) return;
  const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 200));
  idle(() => void loadFind().catch(() => {}));
}

/** How the terminal's shell reads a command line (Windows quotes dropped paths for it). */
const shellKindOf = (id: string) => profileShellKind(useApp.getState().terminals.find((t) => t.id === id)?.profile);

/**
 * focused: the split view's focused pane shows it (only that one takes the keyboard); with one pane, the visible one.
 * place: its grid cell in the split view (the view never moves to another parent: xterm is not remounted).
 */
export function TerminalView({ id, visible, focused = visible, place }: { id: string; visible: boolean; focused?: boolean; place?: CSSProperties }) {
  const slot = useRef<HTMLDivElement>(null);
  const setSize = useApp((s) => s.setSize);
  const refit = useRef<(() => void) | null>(null);

  useEffect(() => {
    const lt = getLiveTerminal(id);
    slot.current?.appendChild(lt.host);
    // ⌘V goes through the filter too: no ESC or control characters from the clipboard (they would run commands in the shell).
    // Files copied in Finder: their paths, as a drop. Only an image on the clipboard (screenshot): paste the path of the
    // saved png, Claude attaches it.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const files = copiedFilesText([...(e.clipboardData?.files ?? [])], (f) => window.atelier.pathForFile(f), shellKindOf(id));
      if (files) {
        for (const part of pasteSequence(files, bracketedPaste(id), 512 * 1024)) sendInput(id, part);
        return;
      }
      void clipboardPayload(text, () => window.atelier.clipboard.saveImage(), () => useApp.getState().showToast(t.imageTooLarge)).then((out) => {
        for (const part of pasteSequence(out ?? '', bracketedPaste(id), 512 * 1024)) sendInput(id, part);
      });
    };
    lt.host.addEventListener('paste', onPaste, true);
    let pending: PendingAttach | null = null;
    if (!lt.attached) {
      lt.attached = true;
      // The main process ignores resizes until the attach completes: the size fitted meanwhile is sent again. A failed
      // attach is tried again while the terminal is listed (attach-retry.ts): never a blank view on a live terminal.
      pending = attachWithRetry(() => window.atelier.terminals.attach(id), {
        alive: () => useApp.getState().terminals.some((x) => x.id === id),
        onAttached: () => refit.current?.()
      });
    }
    return () => {
      lt.host.removeEventListener('paste', onPaste, true);
      if (pending?.cancel()) lt.attached = false;
    };
  }, [id]);

  useEffect(() => {
    if (!visible || !slot.current) return;
    const lt = getLiveTerminal(id);
    const resize = () => {
      try { lt.fit.fit(); } catch { return; }
      if (lt.term.cols < 2 || lt.term.rows < 2) return;
      window.atelier.terminals.resize(id, lt.term.cols, lt.term.rows);
      setSize(lt.term.cols, lt.term.rows);
      // Its screen was written at another size (never fitted behind another tab): asked again, after the resize, so
      // atelierd sends it at this size.
      if (lt.snapshotFit.fitted(lt.term.cols, lt.term.rows) && lt.attached) void window.atelier.terminals.attach(id).catch(() => {});
    };
    const ro = new ResizeObserver(resize);
    ro.observe(slot.current);
    resize();
    refit.current = resize;
    return () => { ro.disconnect(); refit.current = null; };
  }, [id, visible, setSize]);
  // The keyboard goes to the shown terminal; in the split view only to the focused pane's.
  useEffect(() => { if (visible && focused) getLiveTerminal(id).term.focus(); }, [id, visible, focused]);

  // Font or line spacing changed in settings, or a font being previewed: recompute rows and
  // columns, without stealing focus.
  const metrics = useApp((s) => `${s.settings.terminalFontSize}/${s.settings.terminalLineHeight}/${s.fontPreview ?? s.settings.terminalFontFamily}`);
  const firstMetrics = useRef(true);
  useEffect(() => { if (firstMetrics.current) { firstMetrics.current = false; return; } refit.current?.(); }, [metrics]);

  // Find: open while not null, bumped by every request (⌘F, the context menu, the palette).
  const [find, setFind] = useState<number | null>(null);
  const [, setFindLoaded] = useState(false);
  useEffect(() => onTerminalFind(id, () => {
    setFind((n) => (n ?? 0) + 1);
    if (!findModule) void loadFind().then(() => setFindLoaded(true)).catch(() => {});
  }), [id]);
  useEffect(prefetchFind, []);
  const Find = findModule?.TerminalFind;

  // Files dragged from Finder or the tree: paste their path (images become [Image #N] in Claude).
  const [dropping, setDropping] = useState(false);
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(TREE_PATH_TYPE);
  const onDragOver = (e: React.DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: React.DragEvent) => {
    setDropping(false);
    if (!accepts(e)) return;
    e.preventDefault();
    const tree = e.dataTransfer.types.includes(TREE_PATH_TYPE) ? treeDragPath() : null;
    endTreeDrag();
    const paths = tree ? [tree] : [...e.dataTransfer.files].map((f) => window.atelier.pathForFile(f)).filter((p): p is string => !!p);
    for (const part of pasteSequence(dropText(paths, shellKindOf(id)), bracketedPaste(id), 512 * 1024)) sendInput(id, part);
    // Split view: a drop is no pointer press (nothing focused its pane): its pane takes the focus, then the keyboard.
    const st = useApp.getState();
    const pane = st.split.panes.findIndex((p) => p.front === `t:${id}`);
    if (st.split.panes.length > 1 && pane >= 0) st.focusPane(pane);
    getLiveTerminal(id).term.focus();
  };

  const onMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const at = { clientX: e.clientX, clientY: e.clientY };
    const lt = getLiveTerminal(id);
    // A program capturing the mouse (tmux, vim) shows its own menu on this click: none of Atelier's on top (⇧ forces
    // it). Shift+F10 is no click (an event made by the app): Atelier's menu.
    const info = useApp.getState().terminals.find((x) => x.id === id);
    if (e.nativeEvent.isTrusted && !atelierMenuOnRightClick({ mouseTracking: lt.term.modes.mouseTrackingMode !== 'none', foreground: info?.foreground ?? '', shiftKey: e.shiftKey, session: !!info?.session })) return;
    // Command blocks: the command under the pointer can be copied with its output (Shift+F10 has no pointer: none).
    const block = e.clientY > 0 ? lt.blocks.blockAtY(e.clientY) : null;
    // Open in Finder names the folder the terminal is in now (main asks the shell, a few ms); past 250 ms, no name.
    const menuBefore = useApp.getState().menu;
    // The selection to send elsewhere: xterm's, or the one full-screen Claude copied from its own drag (a few ms).
    const own = lt.term.hasSelection() ? lt.term.getSelection() : '';
    const [folder, claude] = await Promise.all([
      Promise.race([window.atelier.terminals.folder(id).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 250))]),
      own ? null : claudeSelectionOf(id)
    ]);
    const text = cleanSelection(own || claude || '');
    // Meanwhile the terminal closed or another menu opened: this one is no longer wanted.
    if (!slot.current?.isConnected || useApp.getState().menu !== menuBefore) return;
    useApp.getState().openMenu(at, terminalMenu({
      finder: { name: folder ? folderName(folder) : null, run: () => void window.atelier.terminals.openFolder(id).catch(() => {}) },
      block: block && {
        copyCommand: block.command ? () => lt.blocks.copyCommand(block) : null,
        copyOutput: lt.blocks.outputOf(block) ? () => lt.blocks.copyOutput(block) : null
      },
      send: text ? { run: () => void textInNewTerminal(text, folder, true), pick: () => useApp.getState().openSendPalette({ text, cwd: folder }) } : null,
      later: text || null,
      // As selected (not cleaned): xterm's, or Claude's (already on the clipboard; copying it again keeps Copy honest).
      copy: own || claude ? () => void copyText(own || claude!) : null,
      // In chunks: a single oversized send would be rejected by term:input.
      paste: () => void window.atelier.clipboard.read().then((raw) => clipboardPayload(raw, () => window.atelier.clipboard.saveImage(), () => useApp.getState().showToast(t.imageTooLarge))).then((text) => {
        if (text === null) { useApp.getState().showToast(t.clipboardTooLarge); return; }
        for (const part of pasteSequence(text, bracketedPaste(id), 512 * 1024)) sendInput(id, part);
        lt.term.focus();
      }),
      selectAll: () => lt.term.selectAll(),
      // After the menu has closed and given the keyboard back: the card's field takes it.
      find: () => setTimeout(() => requestTerminalFind(id), 0),
      clear: () => { lt.term.clear(); lt.term.focus(); }
    }));
  };
  return <div ref={slot} className={`terminal-slot ${dropping ? 'is-drop' : ''}`} style={{ display: visible ? 'block' : 'none', ...place }} onContextMenu={(e) => void onMenu(e)}
    onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }} onDrop={onDrop}>
    {find !== null && Find && <Find id={id} nonce={find} visible={visible} onClose={() => setFind(null)} />}
  </div>;
}
