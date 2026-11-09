// A project window and its pop-out windows share one localStorage but each keeps its own in-memory copy of the
// per-project slices. Chromium fires `storage` in every other window of the origin when one writes, so the others
// reload the slice here. Reloads use useApp.setState only: the store's setX helpers would write back and ping-pong.
import { hasUnsavedComments, useApp, type AppState } from './store';
import { loadComments, KEY as COMMENTS } from './comments';
import { loadNotes, KEY as NOTES } from './notes';
import { loadPins, KEY as PINS } from './pins';
import { loadShelf, KEY as SHELF } from './shelf';
import { loadHidden, KEY as HIDDEN } from './hidden-tabs';
import { loadTaskLinks, KEY as LINKS } from './task-links';
import { loadMdViews, KEY as MD_VIEWS } from './markdown-views';
import { loadOverrides, KEY as LANG } from './lang-overrides';

/** The slice a changed storage key stands for, read from storage now; null when it is not ours or cannot apply here. */
export function reloadFor(key: string): Partial<AppState> | null {
  const st = useApp.getState();
  // Global (not per project): the same files open in every window.
  if (key === MD_VIEWS) return { mdViews: loadMdViews() };
  if (key === LANG) return { langOverrides: loadOverrides() };
  const root = st.project?.root;
  if (!root) return null;
  switch (key) {
    // Comments storage refused here (full) live only in this window: a reload would lose them.
    case COMMENTS: return hasUnsavedComments() ? null : { comments: loadComments(root) };
    case NOTES: return { notes: loadNotes(root) };
    case PINS: return { pins: loadPins(root) };
    // The Shelf is the main window's: a pop-out shows none.
    case SHELF: return st.popout ? null : { shelf: loadShelf(root) };
    case LINKS: return { taskLinks: loadTaskLinks(root) };
    // Which tabs are hidden is the main window's business: a pop-out owns no hidden tabs.
    case HIDDEN: return st.popout ? null : { hidden: loadHidden(root) };
    default: return null;
  }
}

export function installStorageSync(): () => void {
  const onStorage = (e: { key: string | null }): void => {
    if (!e.key) return;
    const patch = reloadFor(e.key);
    if (patch) useApp.setState(patch);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
