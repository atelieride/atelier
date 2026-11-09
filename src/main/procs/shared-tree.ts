import { readProcessTree } from './exec';

/** How long one `ps -A` read serves every reader: ports every 4 s, background work every 3 s. */
export const SHARED_TREE_MS = 2000;

/**
 * One read shared by everyone who asks within SHARED_TREE_MS (or while it runs): the ports hub, the background work
 * scan and the Redis clients each read the process table on their own pace, often within a second of each other.
 * A failed read is not kept, so the next caller tries again.
 */
export function sharedReader<T>(read: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  let last: { at: number; p: Promise<T> } | null = null;
  return () => {
    const t = now();
    if (last && t - last.at < SHARED_TREE_MS) return last.p;
    const p = read();
    const entry = { at: t, p };
    last = entry;
    p.catch(() => { if (last === entry) last = null; });
    return p;
  };
}

/** The process table (pid → children), shared by the main process's readers. */
export const sharedProcessTree = sharedReader(() => readProcessTree());
