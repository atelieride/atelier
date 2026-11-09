// Go › Next Change / Previous Change (⌥F5 / ⌥⇧F5): the file tab in front moves to its next or previous change.
import { useApp } from './store';
import { t } from './i18n/en';
import type { TabKey } from './tabs-model';

/** By tab key: returns false when the file has no changes to move to. */
const targets = new Map<string, (dir: 1 | -1) => boolean>();

export function registerChangeTarget(key: TabKey, run: (dir: 1 | -1) => boolean): () => void {
  targets.set(key, run);
  return () => { if (targets.get(key) === run) targets.delete(key); };
}

export function goToChange(dir: 1 | -1): void {
  const st = useApp.getState();
  const key = st.activeKey();
  const run = key ? targets.get(key) : undefined;
  if (!run?.(dir)) st.showToast(t.noChangesHere, undefined, 'info');
}
