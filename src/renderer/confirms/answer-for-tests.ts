// Tests only: answers the store's unsaved-files question as soon as it is asked, recording
// what was asked. 'save' saves every file asked about.
import { useApp } from '../store';
import type { UnsavedAnswer, UnsavedAsk } from './slice';

export function answerUnsaved(answer: () => 'save' | 'discard' | 'cancel' | UnsavedAnswer): { asked: Pick<UnsavedAsk, 'paths' | 'how' | 'tab'>[]; stop(): void } {
  const asked: Pick<UnsavedAsk, 'paths' | 'how' | 'tab'>[] = [];
  let seen: UnsavedAsk | null = null;
  const stop = useApp.subscribe((s) => {
    const q = s.unsavedAsk;
    if (!q || q === seen) return;
    seen = q;
    asked.push({ paths: q.paths, how: q.how, tab: q.tab });
    const a = answer();
    queueMicrotask(() => useApp.getState().answerUnsaved(a === 'save' ? { save: q.paths } : a));
  });
  return { asked, stop };
}
