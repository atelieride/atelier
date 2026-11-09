// Changes' Filters: what the funnel in the panel's head says about the view.

import type { ChangesGrouping } from './changes-prefs';
import { t } from './i18n/en';

/**
 * `changed` when the view is not the usual one (grouped by session, or only this workspace's changes while workspaces are
 * on), which lights the funnel with a dot; its tooltip says which. Folders are a way to look, not a filter: they never
 * light it.
 */
export function filtersView(grouping: ChangesGrouping, scope: 'ws' | 'all', wsOn: boolean): { changed: boolean; tip: string } {
  const parts = [
    ...(grouping === 'session' ? [t.changesFilters.bySession] : []),
    ...(wsOn && scope === 'ws' ? [t.changesFilters.thisWorkspace] : [])
  ];
  return { changed: parts.length > 0, tip: t.changesFilters.tip(parts) };
}
