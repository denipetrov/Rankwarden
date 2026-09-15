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
 * In memory, per process. A restart forgets the window — a deliberate trade,
 * since persisting every request would cost more than the overrun it guards
 * against, and both upstreams answer 429 as the backstop.
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

  private emptyCounts(): Record<K, number> {
    return Object.fromEntries(this.keys.map((key) => [key, 0])) as Record<K, number>;
  }
}
