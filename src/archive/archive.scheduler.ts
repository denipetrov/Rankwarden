import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import type { Region } from '../blizzard/blizzard.constants.js';
import { BlizzardApiError } from '../blizzard/http/blizzard-api.error.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { withRunId } from '../common/logging/run-context.js';
import { QuotaBudget } from '../common/quota/quota-budget.service.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { ArchiveService } from './archive.service.js';
import type { Subscription } from 'rxjs';

const INTERVAL_NAME = 'season-archive';

/**
 * Works through the archive backlog one season at a time.
 *
 * The backfill is one-off but large, so rather than a single long job this takes
 * a season per pass and comes straight back while work remains — pausing between
 * seasons, and stopping entirely while any live ingestion runs. Once history is
 * in, the interval only has to notice the current season ending.
 */
@Injectable()
export class ArchiveScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ArchiveScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly pauseMs: number;
  private subscription?: Subscription;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly archive: ArchiveService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
    private readonly budget: QuotaBudget,
  ) {
    this.enabled = config.get('ARCHIVE_ENABLED', { infer: true });
    this.intervalMs = config.get('ARCHIVE_CHECK_INTERVAL_MS', { infer: true });
    this.pauseMs = config.get('ARCHIVE_SEASON_PAUSE_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Season archiving disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);

    // Deliberately no tick here. The archive is the lowest priority work in the
    // service, so it waits for the first sweep and the first enrichment pass to
    // finish rather than competing with them for the quota while the live data
    // is still being filled in.
    this.logger.log(
      `Archiving will start once live ingestion has warmed up, then every ${this.intervalMs}ms`,
    );
    this.subscription = this.coordinator.warmedUp$.subscribe(() =>
      this.pending.run(() => this.tick()),
    );
  }

  /** Test seam: the warm-up-driven backfill is fire-and-forget in production. */
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
      this.logger.log('Live ingestion has not completed its first pass; archive waiting');
      return;
    }

    this.running = true;
    // Seasons that failed during this tick. Without it a season that throws is
    // handed straight back by `nextPending` on the next iteration, and every
    // season behind it in the ordering is unreachable for as long as it keeps
    // failing — which, for a season Blizzard no longer serves, is forever.
    const failedThisTick = new Set<string>();

    try {
      // Every request below is charged to the archive's share of the quota.
      await withRunId('archive', async () => {
        for (;;) {
          // Re-checked between seasons: a sweep or enrichment pass starting mid
          // backlog takes the quota back immediately.
          if (this.coordinator.isLiveIngestionActive) {
            this.logger.log('Live ingestion in progress, pausing the archive');
            return;
          }

          // The archive gets only what the sweep and enrichment leave, so it
          // is the job that waits when the hour runs short. The interval
          // brings it back once the window has rolled.
          if (this.budget.allowance('archive') <= 0) {
            this.logger.log(
              'Archive share of the hourly quota is spent; pausing until the window rolls',
            );
            return;
          }

          const pending = await this.archive.nextPending(failedThisTick);
          if (!pending) break;

          const key = `${pending.seasonId}:${pending.region}`;

          try {
            const result = await this.archive.archiveSeason(pending.seasonId, pending.region);

            // Came back incomplete: a bracket could not be fetched. It stays
            // pending, but for the next tick rather than this one.
            // `nextPending` would hand the same season straight back, and a
            // failure that persists would be retried every pause until the
            // archive's share of the quota was gone.
            if (result.failedBrackets.length > 0) failedThisTick.add(key);
          } catch (error) {
            await this.recordFailure(pending.seasonId, pending.region, error);
            failedThisTick.add(key);
          }

          await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
        }

        // Rewards come after the backlog, and only for what it archived: a
        // season finished in this tick gets its rewards in this tick too, and
        // one Blizzard will not serve never gets a marker to be asked about.
        await this.archive.archivePendingRewards();
      });
    } catch (error) {
      this.logger.error('Archiving failed', errorStack(error));
    } finally {
      this.running = false;
    }
  }

  /**
   * A 404 is permanent — Blizzard stops serving old seasons and never resumes —
   * so it is recorded and never attempted again. Anything else could be
   * transient, so it is only skipped for the rest of this tick.
   */
  private async recordFailure(seasonId: number, region: Region, error: unknown): Promise<void> {
    const reason = describeError(error);

    if (error instanceof BlizzardApiError && error.isNotFound) {
      this.logger.warn(
        `Season ${seasonId} ${region} is no longer served by Blizzard (${reason}); ` +
          'marking it unarchivable and moving on',
      );
      await this.archive.markUnarchivable(seasonId, region, reason);
      return;
    }

    this.logger.error(
      `Could not archive season ${seasonId} ${region}: ${reason}; continuing with the backlog`,
      errorStack(error),
    );
  }
}
