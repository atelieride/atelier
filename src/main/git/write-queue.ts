// One git write per object store at a time: jobs on the same git common dir run
// one after the other in the order asked, different common dirs in parallel. Fetches go through the same queue, so a
// fetch asked while a write runs starts after it (and a write asked during a fetch waits for it: fetches are short).

export type WriteKind = 'write' | 'fetch';

interface Lane { tail: Promise<void>; queued: number; running: WriteKind | null }

export class WriteQueue {
  private lanes = new Map<string, Lane>();

  /** Runs `fn` once every job asked before it on that common dir has ended (resolved or not); answers what it answers. */
  run<T>(common: string, fn: () => Promise<T>, kind: WriteKind = 'write'): Promise<T> {
    let lane = this.lanes.get(common);
    if (!lane) { lane = { tail: Promise.resolve(), queued: 0, running: null }; this.lanes.set(common, lane); }
    const l = lane;
    l.queued++;
    const job = l.tail.then(() => { l.running = kind; return fn(); });
    const tail = job.then(() => {}, () => {}).then(() => {
      l.running = null;
      l.queued--;
      if (l.queued === 0 && this.lanes.get(common) === l) this.lanes.delete(common);
    });
    l.tail = tail;
    return job;
  }

  /** Resolves once nothing runs or waits on that common dir, jobs asked in the meantime included. */
  async idle(common: string): Promise<void> {
    for (let lane = this.lanes.get(common); lane; lane = this.lanes.get(common)) await lane.tail;
  }

  /** Something runs or waits on that common dir. */
  busy(common: string): boolean {
    return (this.lanes.get(common)?.queued ?? 0) > 0;
  }

  /** The writes running now (the quit dialog names them; a fetch is stopped with the app anyway). */
  running(): { common: string }[] {
    return [...this.lanes].filter(([, l]) => l.running === 'write').map(([common]) => ({ common }));
  }
}
