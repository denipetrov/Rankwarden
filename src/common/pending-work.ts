/**
 * Tracks background work that is deliberately fire-and-forget.
 *
 * Every scheduler starts work from a lifecycle hook or a timer callback, neither
 * of which can await anything: returning a promise to `setInterval` does nothing,
 * and awaiting inside `onApplicationBootstrap` would block startup behind a full
 * sweep. So the work is launched and dropped.
 *
 * That is correct in production and awkward everywhere else. A test that closes
 * the application while a tick is mid-query has MongoDB shut down underneath it,
 * which surfaces as an intermittent "MongoClient must be connected" that looks
 * like a bug in the test rather than a race in the harness. Keeping a handle on
 * the work costs nothing and makes it awaitable.
 */
export class PendingWork {
  private readonly inFlight = new Set<Promise<unknown>>();

  /**
   * Starts `work` and remembers it until it settles. Rejections are swallowed
   * here — every caller already logs its own failures, and an unhandled
   * rejection from tracking would be worse than the failure it reports.
   */
  run(work: () => Promise<unknown>): void {
    const promise = Promise.resolve()
      .then(work)
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(promise));

    this.inFlight.add(promise);
  }

  /** Whether anything started through `run` is still running. */
  get isIdle(): boolean {
    return this.inFlight.size === 0;
  }

  /**
   * Resolves once nothing is in flight.
   *
   * Loops rather than awaiting the set once, because a settling job can start
   * another before this resolves — the archive works through its backlog that
   * way, and a sweep completing wakes enrichment.
   */
  async whenSettled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
