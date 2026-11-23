/** A token bucket: up to `burst` at once, refilled at `perSec`. The clock can be injected (tests). */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(private readonly burst: number, private readonly perSec: number, private readonly now: () => number = Date.now) {
    this.tokens = burst;
    this.at = now();
  }

  private refill(): void {
    const now = this.now();
    // A clock set back counts as no time passed (never as a debt that stalls what follows for as long as the jump).
    const elapsed = Math.max(0, now - this.at);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.perSec);
    this.at = now;
  }

  /** Ms until `n` tokens are there (0: now). More than the burst waits for a full bucket. */
  wait(n: number): number {
    this.refill();
    const need = Math.min(n, this.burst) - this.tokens;
    return need <= 0 ? 0 : Math.ceil((need / this.perSec) * 1000);
  }

  /** Takes `n` whatever is there (the bucket may go below zero: what follows waits longer). */
  take(n: number): void {
    this.refill();
    this.tokens -= n;
  }

  /** Takes `n` only when they are there; false (nothing taken) otherwise. */
  tryTake(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
