import { useApp } from './store';
import { TREE_PATH_TYPE } from './terminal/drop';

// Finder files dropped anywhere but a terminal open; a terminal keeps pasting their paths.

/** A drag of files from Finder: never one that started in Atelier (a tree row; tabs drag with the pointer). */
export function finderDrag(types: readonly string[]): boolean {
  return types.includes('Files') && !types.includes(TREE_PATH_TYPE);
}

const overTerminal = (e: DragEvent) => e.target instanceof Element && e.target.closest('.terminal-slot') !== null;

/** How long the pill outlives the last dragover: leaving the window sends no reliable dragleave. */
const IDLE_MS = 250;

/** Window-level drop handling. Returns the uninstaller. */
export function installFileDrop(win: Window = window): () => void {
  let idle: ReturnType<typeof setTimeout> | null = null;
  const hide = () => { if (idle) { clearTimeout(idle); idle = null; } useApp.getState().setFileDrag(false); };
  const onOver = (e: DragEvent) => {
    if (!e.dataTransfer || !finderDrag([...e.dataTransfer.types])) return;
    if (overTerminal(e)) { hide(); return; }
    // Without this the drop never fires (the default is "no drop here").
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    useApp.getState().setFileDrag(true);
    if (idle) clearTimeout(idle);
    idle = setTimeout(hide, IDLE_MS);
  };
  const onLeave = (e: DragEvent) => { if (e.relatedTarget === null) hide(); };
  // Capture phase: taken before the editor (CodeMirror would paste the file's text) or a tab (it handles tab drags) see
  // it. Over a terminal it goes on to the terminal, which pastes the paths.
  const onDrop = (e: DragEvent) => {
    hide();
    if (!e.dataTransfer || !finderDrag([...e.dataTransfer.types]) || overTerminal(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = [...e.dataTransfer.files];
    void window.atelier.files.openDropped(files).catch(() => {});
  };
  win.addEventListener('dragover', onOver, true);
  win.addEventListener('dragleave', onLeave);
  win.addEventListener('drop', onDrop, true);
  win.addEventListener('dragend', hide);
  return () => {
    hide();
    win.removeEventListener('dragover', onOver, true);
    win.removeEventListener('dragleave', onLeave);
    win.removeEventListener('drop', onDrop, true);
    win.removeEventListener('dragend', hide);
  };
}
