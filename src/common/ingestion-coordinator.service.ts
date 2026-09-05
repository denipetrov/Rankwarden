import { Injectable, Logger } from '@nestjs/common';
import { ReplaySubject, type Observable } from 'rxjs';

/**
 * Orders the three things that compete for the Blizzard quota and for the same
 * documents.
 *
 * The leaderboard sweep is the live data and never waits. Profile enrichment
 * keeps out of its way. The season archive is the lowest priority of all: it is
 * historical data that has already waited months, so it does not start until the
 * first sweep and the first enrichment pass have both been through, and it steps
 * aside whenever either of them picks up again.
 */
@Injectable()
export class IngestionCoordinator {
  private readonly logger = new Logger(IngestionCoordinator.name);
  private sweepDepth = 0;
  private enrichmentDepth = 0;
  private sweepDone = false;
  private enrichmentDone = false;
  private readonly warmedUpSubject = new ReplaySubject<void>(1);

  /** Emits once, when the first sweep and first enrichment pass have finished. */
  readonly warmedUp$: Observable<void> = this.warmedUpSubject.asObservable();

  get isSweepActive(): boolean {
    return this.sweepDepth > 0;
  }

  get isEnrichmentActive(): boolean {
    return this.enrichmentDepth > 0;
  }

  /** True while anything that serves live data is fetching. */
  get isLiveIngestionActive(): boolean {
    return this.isSweepActive || this.isEnrichmentActive;
  }

  /** Whether live ingestion has completed its first pass of each kind. */
  get isWarmedUp(): boolean {
    return this.sweepDone && this.enrichmentDone;
  }

  /** Marks a sweep as active for the duration of `work`. */
  async duringSweep<T>(work: () => Promise<T>): Promise<T> {
    this.sweepDepth += 1;

    try {
      return await work();
    } finally {
      this.sweepDepth -= 1;

      if (this.sweepDepth === 0) {
        this.sweepDone = true;
        this.signalWarmedUp();
      }
    }
  }

  /** Marks profile enrichment as active for the duration of `work`. */
  async duringEnrichment<T>(work: () => Promise<T>): Promise<T> {
    this.enrichmentDepth += 1;

    try {
      return await work();
    } finally {
      this.enrichmentDepth -= 1;

      if (this.enrichmentDepth === 0) {
        this.enrichmentDone = true;
        this.signalWarmedUp();
      }
    }
  }

  /**
   * Declares that enrichment will never run, so the archive is not held back
   * waiting for a pass that is switched off.
   */
  markEnrichmentDisabled(): void {
    this.enrichmentDone = true;
    this.signalWarmedUp();
  }

  private signalWarmedUp(): void {
    if (!this.isWarmedUp) return;

    // ReplaySubject only forwards the first completion; later passes are no-ops.
    if (!this.warmedUpSubject.closed) {
      this.logger.log('Live ingestion warmed up; lower-priority work may start');
      this.warmedUpSubject.next();
      this.warmedUpSubject.complete();
    }
  }
}
