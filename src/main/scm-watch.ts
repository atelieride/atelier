import type { ScmEvent } from '@shared/scm';

/** Source Control events: a burst (a commit writes refs, HEAD, logs…) becomes one event per repository and kind. */
export class ScmEvents {
  private waiting = new Map<string, ScmEvent>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ms: number, private readonly emit: (e: ScmEvent) => void) {}
  add(e: ScmEvent): void {
    this.waiting.set(`${e.common}\0${e.what}`, e);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const list = [...this.waiting.values()];
      this.waiting.clear();
      this.timer = null;
      for (const x of list) this.emit(x);
    }, this.ms);
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.waiting.clear();
  }
}
