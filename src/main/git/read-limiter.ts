// How many git reads run at once across every project. A folder of hundreds of repositories asks for a status,
// a worktree listing and an ignored-file listing of each at once; on a Windows PC those take seconds, and hundreds of
// them together time out. A slot is one read, not one process: most run one git command, a few several (a
// repository's facts start about ten, together). Reads for something the user is looking at or a session just did
// (live) go before the ones that refresh everything (bulk). A read for the user's own click never queues: callers run
// it directly, or promote a queued one to `now`.

export type ReadLevel = 'live' | 'bulk';

interface Job { key: string | undefined; start: () => void }

export class ReadLimiter {
  private running = 0;
  private readonly queues: Record<ReadLevel, Job[]> = { live: [], bulk: [] };
  /** Jobs started by `promote(…, 'now')`: they hold no slot, so they free none. */
  private readonly unslotted = new Set<Job>();

  constructor(private readonly max: number) {}

  /** Runs `fn` once a slot is free (live before bulk, first come first served within a level). */
  run<T>(level: ReadLevel, fn: () => Promise<T>, key?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        key,
        start: () => {
          let p: Promise<T>;
          try { p = fn(); } catch (e) { p = Promise.reject(e); }
          p.then(resolve, reject).finally(() => this.release(job));
        }
      };
      this.queues[level].push(job);
      this.pump();
    });
  }

  /**
   * A queued read with this key: `live` moves it to the end of the live queue, `now` starts it at once without a slot
   * (the user is waiting on it). A read already running, or a key nobody queued, is left alone.
   */
  promote(key: string, to: 'live' | 'now'): void {
    for (const level of ['bulk', 'live'] as const) {
      const q = this.queues[level];
      const i = q.findIndex((j) => j.key === key);
      if (i < 0) continue;
      if (to === 'live' && level === 'live') return;
      const [job] = q.splice(i, 1);
      if (to === 'live') { this.queues.live.push(job!); this.pump(); return; }
      this.unslotted.add(job!);
      job!.start();
      return;
    }
  }

  private release(job: Job): void {
    if (this.unslotted.delete(job)) return;
    this.running--;
    this.pump();
  }

  private pump(): void {
    while (this.running < this.max) {
      const job = this.queues.live.shift() ?? this.queues.bulk.shift();
      if (!job) return;
      this.running++;
      job.start();
    }
  }
}

/** The one limiter every many-repository git read goes through. */
export const gitReadLimiter = new ReadLimiter(4);
