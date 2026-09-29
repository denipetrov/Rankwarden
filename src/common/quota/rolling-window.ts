/**
 * A rolling count of events over the recent past, kept in fixed-size buckets.
 *
 * Extracted from `QuotaBudget` when Raider.io arrived as a second upstream with
 * its own, differently-shaped quota: Blizzard caps requests per *hour*,
 * Raider.io per *minute*. The two budgets share nothing else — Blizzard's has
 * priority shares between four jobs, Raider.io's has one consumer — but they do
 * share the only part that is fiddly enough to get wrong twice: a counter that
 * forgets old events without holding a timestamp per event.
 *
 * Counting is done in buckets of `bucketMs` over the current bucket and the
 * previous `windowBuckets`, so an event is remembered for between one and one
 * plus `1/windowBuckets` windows. That errs towards over-counting, which is the
 * right direction for a quota: spending slightly less than allowed costs a
 * little throughput, spending more costs a ban.
 *
 * In memory, per process. `snapshot` and `restore` let an owner carry the
 * window across a restart; the Raider.io budget does (`RaiderIoBudgetStore`),
 * because its window is a minute and a quick restart would otherwise hand a
 * pass a whole fresh minute on top of the one just spent.
 */
export class RollingWindow<K extends string> {
  /** Injectable clock, so the window can be tested without waiting for it. */
  now: () => number = Date.now;

  private readonly buckets: { index: number; counts: Record<K, number> }[];

  constructor(
    private readonly keys: readonly K[],
    private readonly bucketMs: number,
    private readonly windowBuckets: number,
  ) {
    // One spare bucket beyond the window, plus a small margin: the ring is
    // indexed modulo its own length, so a size equal to the window would let
    // the newest bucket land on the oldest one still being counted.
    const slots = windowBuckets + 4;

    this.buckets = Array.from({ length: slots }, () => ({
      index: Number.NEGATIVE_INFINITY,
      counts: this.emptyCounts(),
    }));
  }

  /** Charges `count` events to a key. Called once per real event. */
  record(key: K, count = 1): void {
    const index = Math.floor(this.now() / this.bucketMs);
    const bucket = this.buckets[index % this.buckets.length];

    if (bucket.index !== index) {
      bucket.index = index;
      bucket.counts = this.emptyCounts();
    }

    bucket.counts[key] += count;
  }

  /** Events counted in the rolling window, for one key or across all of them. */
  spent(key?: K): number {
    const current = Math.floor(this.now() / this.bucketMs);
    let total = 0;

    for (const bucket of this.buckets) {
      if (bucket.index < current - this.windowBuckets || bucket.index > current) continue;

      total += key
        ? bucket.counts[key]
        : this.keys.reduce((sum, name) => sum + bucket.counts[name], 0);
    }

    return total;
  }

  /** The buckets still inside the window, for persisting it. */
  snapshot(): { index: number; counts: Record<K, number> }[] {
    const current = Math.floor(this.now() / this.bucketMs);

    return this.buckets
      .filter((bucket) => bucket.index >= current - this.windowBuckets && bucket.index <= current)
      .map((bucket) => ({ index: bucket.index, counts: { ...bucket.counts } }));
  }

  /**
   * Adds persisted buckets back. Bucket indices are absolute (time over
   * `bucketMs`), so a bucket from before a restart lands in its own slot and
   * ages out on schedule; anything already outside the window is ignored.
   */
  restore(saved: readonly { index: number; counts: Partial<Record<K, number>> }[]): void {
    const current = Math.floor(this.now() / this.bucketMs);

    for (const entry of saved) {
      if (entry.index < current - this.windowBuckets || entry.index > current) continue;

      const bucket = this.buckets[entry.index % this.buckets.length];
      if (bucket.index !== entry.index) {
        bucket.index = entry.index;
        bucket.counts = this.emptyCounts();
      }
      for (const key of this.keys) bucket.counts[key] += entry.counts[key] ?? 0;
    }
  }

  private emptyCounts(): Record<K, number> {
    return Object.fromEntries(this.keys.map((key) => [key, 0])) as Record<K, number>;
  }
}
