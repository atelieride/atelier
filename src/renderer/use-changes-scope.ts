// Changes' Show in components: the store's pieces the scope reads, each with its own selector (never a new object per
// selector), put together once per change.

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { scopeInputs, type ScopeState } from './changes-scope';
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
 * A component that reads the rows shown through `getState()` (Source Control's blocks: their Stage All offer) renders
 * again when anything they depend on changes: the scope, what it follows, the attributions and the places.
 */
export function useScopeInputs(): void {
  useApp(useShallow(scopeInputs));
}
