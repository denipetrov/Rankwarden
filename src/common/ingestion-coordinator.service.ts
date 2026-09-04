import { Injectable, Logger } from '@nestjs/common';

/**
 * Keeps the leaderboard sweep and profile enrichment off each other's toes.
 *
 * They write to the same documents and draw on the same API quota, so a sweep
 * claims exclusivity for its duration: enrichment refuses to start while one is
 * active, and an in-flight enrichment pass stops between characters when a
 * sweep begins. The sweep is the one that must not be delayed — it is what
 * keeps rankings current.
 */
@Injectable()
export class IngestionCoordinator {
  private readonly logger = new Logger(IngestionCoordinator.name);
  private sweepDepth = 0;

  get isSweepActive(): boolean {
    return this.sweepDepth > 0;
  }

  /** Marks a sweep as active for the duration of `work`. */
  async duringSweep<T>(work: () => Promise<T>): Promise<T> {
    this.sweepDepth += 1;

    try {
      return await work();
    } finally {
      this.sweepDepth -= 1;

      if (this.sweepDepth === 0) {
        this.logger.debug('Sweep finished, enrichment may resume');
      }
    }
  }
}
