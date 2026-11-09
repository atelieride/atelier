/**
 * The green dot on the Changelog tab: a version came out since this browser last opened /changelog. The first visit
 * only remembers the latest version. `store`: what to remember now (null: nothing).
 */
export function changelogDot(stored: string | null, latest: string, onChangelog: boolean): { show: boolean; store: string | null } {
  if (stored === latest) return { show: false, store: null };
  if (stored === null || onChangelog) return { show: false, store: latest };
  return { show: true, store: null };
}
