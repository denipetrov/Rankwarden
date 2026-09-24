import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { withRunId } from '../common/logging/run-context.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MplusSeasonService } from './mplus-season.service.js';

const INTERVAL_NAME = 'mplus-season-check';

/**
 * Keeps the Mythic+ season catalogue loaded and the current season observed, on
 * its own schedule. The counterpart of `SeasonScheduler`.
 *
 * It ticks at bootstrap, which is what puts the catalogue in place before
 * anything asks for runs: the live pass waits for the PvP warm-up, so by the
 * time it starts the catalogue has long been read. The pass does not rely on
 * that ordering — it ensures the catalogue itself before its first page — but
 * reading it here first means a pass never spends its own time on it.
 *
 * Hourly by default, where the PvP check is daily, because a tick here costs no
 * request: the catalogue is re-read only when its TTL says so, and resolving
 * the season is a database read. The hour is how late a season opening or
 * ending is noticed when no pass happens to run first.
 *
 * Idle unless a Mythic+ job is switched on. Without one there is nothing to
 * resolve a season for — and no Raider.io key to read the catalogue with.
 */
@Injectable()
export class MplusSeasonScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MplusSeasonScheduler.name);
  private readonly enabled: boolean;
  private readonly anyMplusJob: boolean;
  private readonly intervalMs: number;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly seasons: MplusSeasonService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.enabled = config.get('MPLUS_SEASON_REFRESH_ENABLED', { infer: true });
    this.anyMplusJob =
      config.get('MPLUS_ENABLED', { infer: true }) ||
      config.get('MPLUS_ARCHIVE_ENABLED', { infer: true });
    this.intervalMs = config.get('MPLUS_SEASON_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Mythic+ season checks disabled');
      return;
    }

    if (!this.anyMplusJob) {
      this.logger.log('No Mythic+ job is enabled; Mythic+ season checks idle');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Checking the Mythic+ season every ${this.intervalMs}ms`);

    this.pending.run(() => this.tick());
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Test seam: the bootstrap check is fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await withRunId('mplus-season', async () => {
        await this.seasons.ensureCatalogue();
        await this.seasons.observe();
      });
    } catch (error) {
      // `describeError`, so a Raider.io outage stays one log line. The next
      // tick tries again, and a pass ensures the catalogue for itself.
      this.logger.error(
        `Could not check the Mythic+ season: ${describeError(error)}`,
        errorStack(error),
      );
    } finally {
      this.running = false;
    }
  }
}
