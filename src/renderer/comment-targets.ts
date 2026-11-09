// ⌘⌥C (Review › Comment on Selection): the visible editor or review opens a comment box for its selection.
import { useApp } from './store';
import { t } from './i18n/en';
import type { TabKey } from './tabs-model';

/** By tab key: returns false when nothing suitable is selected there. */
const targets = new Map<string, () => boolean>();

export function registerCommentTarget(key: TabKey, run: () => boolean): () => void {
  targets.set(key, run);
  return () => { if (targets.get(key) === run) targets.delete(key); };
}

export function commentOnSelection(): void {
  const st = useApp.getState();
  const key = st.activeKey();
  const run = key ? targets.get(key) : undefined;
  if (!run?.()) st.showToast(t.comments.selectLines, undefined, 'info');
}
