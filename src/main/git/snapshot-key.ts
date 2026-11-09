/** A project's git snapshot as the windows see it: `checkedAt` (when the status was read) left out. */
export function gitSnapshotKey(repos: unknown): string {
  return JSON.stringify(repos, (k, v: unknown) => (k === 'checkedAt' ? undefined : v)) ?? 'undefined';
}
