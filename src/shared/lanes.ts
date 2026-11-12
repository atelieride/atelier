// A few independent jobs at once, in lanes: the items of one lane run one after another, in the order given, and at
// most `limit` lanes run at a time, taken in the order of their first item. Bulk git runs (Sync All, Pull All, Push
// All) use a repository's object store (its git common dir) as the lane: main writes one store at a time anyway, so
// two worktrees of one repository in two slots would leave one of them waiting while other repositories could run.

/** How many repositories a bulk git run (Sync All, Pull All, Push All) works on at once. */
export const BULK_GIT_PARALLEL = 4;

/**
 * Runs `fn` on every item, `limit` lanes at a time (one at worst). A rejection stops nothing: every other item still
 * runs, and the run rejects with the first one once all have ended.
 */
export async function inLanes<T>(items: readonly T[], laneOf: (item: T) => string, limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const key = laneOf(item);
    const lane = lanes.get(key);
    if (lane) lane.push(item); else lanes.set(key, [item]);
  }
  const queue = [...lanes.values()];
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    for (let lane = queue.shift(); lane; lane = queue.shift()) {
      for (const item of lane) {
        try { await fn(item); } catch (error) { failure ??= { error }; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), queue.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
