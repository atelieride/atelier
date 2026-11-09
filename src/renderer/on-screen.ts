// The terminals on screen right now (used by notes' read marks, the chime and Ask's unseen mark).
import { isSplit, visibleKeys } from './split';
import { viewingNow } from './notes';
import type { AppState } from './store';

type Inputs = Pick<AppState, 'selectedId' | 'activeTab' | 'split' | 'settingsOpen' | 'paletteOpen'>;

/** The terminals on screen in a focused, uncovered window: every pane of a split, else the one in front. */
export function onScreen(st: Inputs, viewing: string | null): Set<string> {
  const front = viewing ?? viewingNow(st.selectedId, st.activeTab, typeof document !== 'undefined' && document.hasFocus(), st.settingsOpen !== null || st.paletteOpen);
  if (!isSplit(st.split) || typeof document === 'undefined' || !document.hasFocus() || st.settingsOpen !== null || st.paletteOpen) return new Set(front ? [front] : []);
  return new Set(visibleKeys(st.split).filter((k) => k.startsWith('t:')).map((k) => k.slice(2)));
}
