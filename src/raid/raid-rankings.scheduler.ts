import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { withRunId } from '../common/logging/run-context.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { RaidRankingsService } from './raid-rankings.service.js';

const INTERVAL_NAME = 'raid-rankings';

/**
 * Reads the raid boards in whatever time every other job leaves: the lowest
 * priority in the service.
 *
 * Nothing at boot. Gated, like the Mythic+ archive, on `warmedUp$` (the first
 * sweep and enrichment pass) and on `mplusWarmedUp$` (the first Mythic+ pass),
 * ticking on both since they arrive in either order; a job that is switched
 * off releases its gate at boot. After that, one run per interval.
 *
 * A run waits for every job on the coordinator to be idle before it starts, and
 * again before each board: one that starts meanwhile — enrichment does, every
 * few minutes — pauses the run rather than ending it, and it carries on where
 * it was. Waited for, not skipped, for the reason `IngestionCoordinator.waitFor`
 * gives; bounded by `ARCHIVE_WAIT_FOR_IDLE_MS`, after which the run ends and
 * what it did not read is due at the next tick. A run still going when the next
 * tick comes is not stacked on.
 */
@Injectable()
export class RaidRankingsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RaidRankingsScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly waitForIdleMs: number;
  private readonly pending = new PendingWork();
  private readonly subscriptions: Subscription[] = [];
  /** A tick in progress, waiting included, so ticks never stack while one waits. */
  private running = false;
  private stopping = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly rankings: RaidRankingsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.enabled = config.get('RAID_RANKINGS_ENABLED', { infer: true });
    this.intervalMs = config.get('RAID_RANKINGS_INTERVAL_MS', { infer: true });
    this.waitForIdleMs = config.get('ARCHIVE_WAIT_FOR_IDLE_MS', { infer: true }) ?? 0;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Raid rankings disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      'Raid rankings will start once every other job has completed a first pass, ' +
        `then every ${this.intervalMs}ms`,
    );

    for (const signal of [this.coordinator.warmedUp$, this.coordinator.mplusWarmedUp$]) {
      this.subscriptions.push(signal.subscribe(() => this.pending.run(() => this.tick())));
    }
  }

  onModuleDestroy(): void {
    // Asked before each board, so a backfill in progress ends at the next one.
    this.stopping = true;
    for (const subscription of this.subscriptions) subscription.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Test seam: the warm-up-driven first run is fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  /** Resolves true once nothing above the rankings is running, false if the wait ran out. */
  private whenClear(): Promise<boolean> {
    return this.coordinator.waitFor(
      () => !this.coordinator.isAboveRaidRankingsActive,
      this.waitForIdleMs,
    );
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    // Both gates, checked at every tick rather than trusted from whichever
    // signal fired: the two arrive in either order.
    if (!this.coordinator.isWarmedUp || !this.coordinator.isMplusWarmedUp) return;

    this.running = true;

    try {
      if (!(await this.whenClear())) {
        this.logger.debug('Another job is still running; raid rankings wait for the next tick');
        return;
      }

      await withRunId('raid-rankings', () =>
        this.rankings.refreshDue(new Date(), {
          shouldStop: () => this.stopping,
          whenClear: () => this.whenClear(),
        }),
      );
    } catch (error) {
      this.logger.error(`Could not read raid rankings: ${describeError(error)}`, errorStack(error));
    } finally {
      this.running = false;
    }
  }
}
