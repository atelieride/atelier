import type { OpenPathsEvent } from '@shared/files';
import { t } from './i18n/en';
import { useApp } from './store';

/** What a drop, Open File… or macOS asked to open that didn't open, as one toast (null: everything opened). */
export function openPathsToast(ev: OpenPathsEvent): string | null {
  if (ev.needsProject > 0) return t.openAny.needsProject;
  const parts = [
    ...(ev.capped !== null ? [t.openAny.capped(ev.capped, ev.files.length || 20)] : []),
    ...(ev.skipped > 0 ? [t.openAny.skipped(ev.skipped)] : [])
  ];
  return parts.length ? parts.join(' ') : null;
}

/**
 * main's ev:open-paths: normal tabs, the last in front, at a line when one came (a link followed
 * in a pop-out); a project folder shown in the tree.
 */
export function applyOpenPaths(ev: OpenPathsEvent): void {
  const st = useApp.getState();
  // Opened again by a gesture: a shelf file main did not grant at launch is readable now.
  const opened = new Set(ev.files.map((f) => f.path));
  if (st.shelfUngranted.some((p) => opened.has(p))) useApp.setState({ shelfUngranted: st.shelfUngranted.filter((p) => !opened.has(p)) });
  for (const f of ev.files) useApp.getState().openFile(f.path, f.rel, f.line ?? null, undefined, { preview: false });
  if (ev.reveal) st.revealInTree(ev.reveal);
  const toast = openPathsToast(ev);
  if (toast) useApp.getState().showToast(toast);
}
