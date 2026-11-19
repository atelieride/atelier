// Changes' Show in components: the store's pieces the scope reads, each with its own selector (never a new object per
// selector), put together once per change.

import { useMemo } from 'react';
import { scopeViewOf, type ScopeState } from './changes-scope';
import { useApp } from './store';

export function useScopeState(): ScopeState {
  const ws = useApp((s) => s.ws);
  const popout = useApp((s) => s.popout);
  const changesScope = useApp((s) => s.changesScope);
  const changesSession = useApp((s) => s.changesSession);
  const terminals = useApp((s) => s.terminals);
  const wsActivities = useApp((s) => s.settings.wsActivities);
  return useMemo(() => ({ ws, popout, changesScope, changesSession, terminals, settings: { wsActivities } }),
    [ws, popout, changesScope, changesSession, terminals, wsActivities]);
}

/**
 * What decides the rows shown, as one string: a component that reads `shownChanges` through `getState()` renders again
 * when it changes (the scope in effect, the session or place it follows).
 */
export function useScopeKey(): string {
  return useApp((s) => {
    const v = scopeViewOf(s);
    return `${v.scope}:${v.scope === 'session' ? v.session ?? '' : v.scope === 'all' ? '' : v.ws?.active ?? ''}`;
  });
}
