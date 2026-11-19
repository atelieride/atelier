// Changes' Filters: what the funnel in the panel's head says about the view.

import type { ChangesGrouping } from './changes-prefs';
import { scopeInEffect, type ChangesScope } from './changes-scope';
import { t } from './i18n/en';

const SCOPE_WORDS: Record<Exclude<ChangesScope, 'all'>, () => string> = {
  ws: () => t.changesFilters.thisWorkspace,
  activity: () => t.changesFilters.thisActivity,
  session: () => t.changesFilters.thisSession
};

/**
 * `changed` when the view is not the usual one (grouped by session, or only this workspace's, this activity's or this
 * session's changes), which lights the funnel with a dot; its tooltip says which. A choice no longer `offered` (its
 * feature turned off) is no filter. Folders are a way to look, not a filter: they never light it.
 */
export function filtersView(grouping: ChangesGrouping, scope: ChangesScope, offered: readonly ChangesScope[]): { changed: boolean; tip: string } {
  const shown = scopeInEffect(scope, offered);
  const parts = [
    ...(grouping === 'session' ? [t.changesFilters.bySession] : []),
    ...(shown !== 'all' ? [SCOPE_WORDS[shown]()] : [])
  ];
  return { changed: parts.length > 0, tip: t.changesFilters.tip(parts) };
}
