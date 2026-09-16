import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { PendingWork } from '../common/pending-work.js';
import { errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MplusArchiveService } from './mplus-archive.service.js';

const INTERVAL_NAME = 'mplus-archive';

/**
 * Runs the Mythic+ archive in whatever time every other job leaves.
 *
 * Gated twice, on `warmedUp$` (the first sweep and enrichment pass) and on
 * `mplusWarmedUp$` (the first Mythic+ pass), and it ticks on both: whichever
 * arrives second is the one that finds both conditions met. When Mythic+ is
 * switched off the second gate is released at boot, so the archive is not held
 * forever by a job that never runs.
 *
 * Once the backlog is in, a tick costs one indexed read and, once a day, the
 * seven requests of a catalogue refresh.
 */
@Injectable()
export class MplusArchiveScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MplusArchiveScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly pending = new PendingWork();
  private readonly subscriptions: Subscription[] = [];

  constructor(
    config: ConfigService<Env, true>,
    private readonly archive: MplusArchiveService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.enabled = config.get('MPLUS_ARCHIVE_ENABLED', { infer: true });
    this.intervalMs = config.get('MPLUS_ARCHIVE_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Mythic+ archiving disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);

    this.logger.log(
      'Mythic+ archiving will start once every other job has completed a first pass, ' +
        `then every ${this.intervalMs}ms`,
    );

    for (const signal of [this.coordinator.warmedUp$, this.coordinator.mplusWarmedUp$]) {
      this.subscriptions.push(signal.subscribe(() => this.pending.run(() => this.tick())));
    }
  }

  /** Test seam: the warm-up-driven first tick is fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) subscription.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async tick(): Promise<void> {
    if (this.archive.isRunning) return;

    // Both gates, checked at every tick rather than trusted from whichever
    // signal fired: the two arrive in either order.
    if (!this.coordinator.isWarmedUp || !this.coordinator.isMplusWarmedUp) return;

    if (this.coordinator.isAboveMplusArchiveActive) {
      this.logger.debug('Another job is running; the Mythic+ archive waits for the next tick');
      return;
    }

    try {
      await this.archive.archiveBacklog();
    } catch (error) {
      this.logger.error('Mythic+ archiving failed', errorStack(error));
    }
  }
}
