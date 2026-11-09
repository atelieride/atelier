// Automations tabs: one per automation (`au:<id>`), and every project's list
// (`au:all`).
import type { AutomationView } from '@shared/api';
import { isAutoTabKey } from '@shared/view-keys';
import { t } from '../i18n/en';
import type { TabKey } from '../tabs-model';

/** A tab's name: its automation's, or "All automations" for every project's list. */
export function autoTabTitle(id: string | null, automations: readonly AutomationView[]): string {
  if (id === null) return t.auto.allTitle;
  return automations.find((v) => v.automation.id === id)?.automation.name ?? t.auto.tab;
}

/** An automation's tab key; null: every project's list. */
export function autoKey(id: string | null): TabKey {
  return id === null ? 'au:all' : `au:${id}`;
}

/** What a key names (id null: every project's list); null for anything that isn't an Automations tab key. */
export function parseAutoKey(k: string): { id: string | null } | null {
  if (!isAutoTabKey(k)) return null;
  return { id: k === 'au:all' ? null : k.slice(3) };
}
