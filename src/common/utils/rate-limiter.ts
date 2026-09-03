/**
 * Token bucket that paces outbound requests. Blizzard allows 100 requests per
 * second and 36,000 per hour, and profile enrichment is the only thing here
 * that can realistically approach either ceiling.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly requestsPerSecond: number) {
    if (requestsPerSecond <= 0) {
      throw new RangeError(`requestsPerSecond must be > 0, received ${requestsPerSecond}`);
    }
    this.tokens = requestsPerSecond;
  }

  /** Resolves once a request may be sent, sleeping only when the bucket is dry. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = Math.ceil(((1 - this.tokens) / this.requestsPerSecond) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;

    if (elapsedSeconds > 0) {
      this.tokens = Math.min(
        this.requestsPerSecond,
        this.tokens + elapsedSeconds * this.requestsPerSecond,
      );
      this.lastRefill = now;
    }
  }
}
