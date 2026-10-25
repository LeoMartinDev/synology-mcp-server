/** Counts events (failed sign-ins, registrations…) per key over a sliding window. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  record(key: string): void {
    this.hits.set(key, [...this.recent(key), this.now()]);
  }

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const hits = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (hits.length) this.hits.set(key, hits);
    else this.hits.delete(key);
    return hits;
  }
}
