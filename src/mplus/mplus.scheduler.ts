import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { PendingWork } from '../common/pending-work.js';
import { errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MplusService } from './mplus.service.js';

const INTERVAL_NAME = 'mplus-sweep';

/**
 * Runs the Mythic+ pass on its own interval, out of the PvP jobs' way.
 *
 * Gated on `warmedUp$` rather than ticking at bootstrap, exactly as the archive
 * is. A pass is minutes of sustained fetching and hundreds of thousands of
 * writes, and at boot that would land on top of the first sweep and the first
 * enrichment pass — the two things that have to finish before the service is
 * serving anything. `markEnrichmentDisabled()` releases the gate when
 * enrichment is switched off, so this does not wait forever for a pass that
 * never comes.
 */
@Injectable()
export class MplusScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MplusScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly pending = new PendingWork();
  private subscription?: Subscription;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly mplus: MplusService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.enabled = config.get('MPLUS_ENABLED', { infer: true });
    this.intervalMs = config.get('MPLUS_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Mythic+ ingestion disabled');
      // Releases the Mythic+ archive, which otherwise waits for a first pass
      // that is never coming.
      this.coordinator.markMplusDisabled();
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);

    this.logger.log(
      `Mythic+ ingestion will start once live ingestion has warmed up, then every ${this.intervalMs}ms`,
    );
    this.subscription = this.coordinator.warmedUp$.subscribe(() =>
      this.pending.run(() => this.tick()),
    );
  }

  /** Test seam: the warm-up-driven first pass is fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    if (!this.coordinator.isWarmedUp) {
      this.logger.log('Live ingestion has not completed its first pass; Mythic+ waiting');
      return;
    }

    // Skipped rather than queued, like an overlapping sweep: a pass that waited
    // for the one in front of it would start against a leaderboard the first
    // pass had already written, and the two would race each other's prunes.
    if (this.coordinator.isLiveIngestionActive) {
      this.logger.log('Live PvP ingestion in progress; deferring the Mythic+ pass');
      return;
    }

    this.running = true;

    try {
      // No `withRunId` here: `MplusService.sweep` establishes its own, so a
      // pass is attributed to the M+ consumer however it was started.
      await this.mplus.sweep();
    } catch (error) {
      this.logger.error('Mythic+ ingestion failed', errorStack(error));
    } finally {
      this.running = false;
    }
  }
}
