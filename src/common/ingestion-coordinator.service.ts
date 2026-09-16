import { Injectable, Logger } from '@nestjs/common';
import { ReplaySubject, type Observable } from 'rxjs';

/**
 * Orders the jobs that compete for an upstream quota, for MongoDB, or for the
 * same documents.
 *
 * The leaderboard sweep is the live data and never waits. Profile enrichment
 * keeps out of its way. The Mythic+ pass yields to both, and the season archive
 * is the lowest priority of all: it is historical data that has already waited
 * months, so it does not start until the first sweep and the first enrichment
 * pass have both been through, and it steps aside whenever anything above it
 * picks up again.
 *
 * Mythic+ is here for a different reason from the rest. It talks to Raider.io,
 * which meters separately from Blizzard, so no *request* of its competes with
 * the PvP jobs — it yields because it shares MongoDB and the process, and a
 * minutes-long pass writing hundreds of thousands of documents alongside a
 * sweep would slow the boards that serve live traffic. Making that an explicit
 * ordering rather than an accident is the whole point of putting it here.
 *
 * The Mythic+ archive sits below everything, the PvP archive included. It is
 * static history fetched once, so it has no reason to compete with anything:
 * it waits for the first sweep, the first enrichment pass *and* the first
 * Mythic+ pass, and yields whenever any other job is active.
 */
@Injectable()
export class IngestionCoordinator {
  private readonly logger = new Logger(IngestionCoordinator.name);
  private sweepDepth = 0;
  private enrichmentDepth = 0;
  private mplusDepth = 0;
  private archiveDepth = 0;
  private mplusArchiveDepth = 0;
  private sweepDone = false;
  private enrichmentDone = false;
  private mplusDone = false;
  private readonly warmedUpSubject = new ReplaySubject<void>(1);
  private readonly mplusWarmedUpSubject = new ReplaySubject<void>(1);

  /** Emits once, when the first sweep and first enrichment pass have finished. */
  readonly warmedUp$: Observable<void> = this.warmedUpSubject.asObservable();

  /**
   * Emits once, when the first Mythic+ pass has finished — or at once, when
   * Mythic+ is switched off and no pass will ever come.
   *
   * A separate signal rather than a condition folded into `warmedUp$`, because
   * the PvP archive must not start waiting on a Mythic+ job it has nothing to do
   * with. Only the Mythic+ archive needs both.
   */
  readonly mplusWarmedUp$: Observable<void> = this.mplusWarmedUpSubject.asObservable();

  get isSweepActive(): boolean {
    return this.sweepDepth > 0;
  }

  get isEnrichmentActive(): boolean {
    return this.enrichmentDepth > 0;
  }

  get isMplusActive(): boolean {
    return this.mplusDepth > 0;
  }

  get isArchiveActive(): boolean {
    return this.archiveDepth > 0;
  }

  get isMplusArchiveActive(): boolean {
    return this.mplusArchiveDepth > 0;
  }

  /** Whether the first Mythic+ pass has finished, or Mythic+ is switched off. */
  get isMplusWarmedUp(): boolean {
    return this.mplusDone;
  }

  /**
   * Whether anything the Mythic+ archive must wait for is running: every other
   * job in the service. Named for its one caller, so the priority it encodes is
   * read where it is decided rather than reassembled at each use.
   */
  get isAboveMplusArchiveActive(): boolean {
    return this.isLiveIngestionActive || this.isMplusActive || this.isArchiveActive;
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

  /**
   * Marks a Mythic+ pass as active for the duration of `work`.
   *
   * Deliberately not folded into `isLiveIngestionActive`: the archive must wait
   * for it, but enrichment must not. Enrichment spends Blizzard quota and M+
   * spends none, so making enrichment yield here would cost the PvP profiles
   * freshness to protect a job that is not competing with them for anything
   * they need.
   */
  async duringMplus<T>(work: () => Promise<T>): Promise<T> {
    this.mplusDepth += 1;

    try {
      return await work();
    } finally {
      this.mplusDepth -= 1;

      if (this.mplusDepth === 0) this.markMplusWarmedUp();
    }
  }

  /**
   * Marks a PvP archive tick as active for the duration of `work`.
   *
   * Nothing above the archive waits on this; it exists so the Mythic+ archive
   * can yield to it. Without it the two lowest-priority jobs would run together
   * in every gap the live jobs leave, which is the one arrangement "lowest
   * priority" is meant to rule out.
   */
  async duringArchive<T>(work: () => Promise<T>): Promise<T> {
    this.archiveDepth += 1;

    try {
      return await work();
    } finally {
      this.archiveDepth -= 1;
    }
  }

  /** Marks a Mythic+ archive tick as active for the duration of `work`. */
  async duringMplusArchive<T>(work: () => Promise<T>): Promise<T> {
    this.mplusArchiveDepth += 1;

    try {
      return await work();
    } finally {
      this.mplusArchiveDepth -= 1;
    }
  }

  /**
   * Declares that Mythic+ will never run, so the Mythic+ archive is not held
   * back waiting for a pass that is switched off. The counterpart of
   * `markEnrichmentDisabled`.
   */
  markMplusDisabled(): void {
    this.markMplusWarmedUp();
  }

  private markMplusWarmedUp(): void {
    this.mplusDone = true;

    if (!this.mplusWarmedUpSubject.closed) {
      this.mplusWarmedUpSubject.next();
      this.mplusWarmedUpSubject.complete();
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
