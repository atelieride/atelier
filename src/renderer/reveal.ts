// File › Reveal in Finder (⌘⌥R): the tab in front in Finder. A terminal opens the folder it is in now
// (main reads it: Claude's folder for a session, the shell's after `cd` otherwise); a file is shown selected.
import { useApp } from './store';
import { t } from './i18n/en';
import { isUntitled } from './untitled';

export function revealActive(): void {
  const st = useApp.getState();
  const key = st.activeKey();
  if (key?.startsWith('t:')) { void window.atelier.terminals.openFolder(key.slice(2)).catch(() => {}); return; }
  if (key?.startsWith('f:') && !isUntitled(key.slice(2))) { void window.atelier.reveal(key.slice(2)); return; }
  st.showToast(t.nothingToReveal, undefined, 'info');
}

/** The folder's last name for a menu label ("api"), or the path itself for the root ("/"). */
export function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
