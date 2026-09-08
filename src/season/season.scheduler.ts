import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import type { Region } from '../blizzard/blizzard.constants.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { SeasonService } from './season.service.js';

const INTERVAL_NAME = 'season-refresh';

/**
 * Re-checks which season is active on its own schedule.
 *
 * A sweep refreshes the season as a side effect of building its jobs, but that
 * couples season tracking to ingestion running and succeeding. This keeps the
 * answer current on its own terms, so a rollover is noticed even if sweeps are
 * disabled, failing, or spaced far apart — and without a restart.
 */
@Injectable()
export class SeasonScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SeasonScheduler.name);
  private readonly regions: Region[];
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly seasons: SeasonService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
    this.enabled = config.get('SEASON_REFRESH_ENABLED', { infer: true });
    this.intervalMs = config.get('SEASON_REFRESH_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Season refresh disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.refreshAll()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Re-checking the active season every ${this.intervalMs}ms`);

    this.pending.run(() => this.refreshAll());
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /**
   * Resolves once the bootstrap refresh and any in-flight tick have finished.
   *
   * A test seam: this work is deliberately fire-and-forget in production, but
   * `season_state` is written by it, so anything asserting on season state
   * would otherwise have to poll for it or race it.
   */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  /**
   * Refreshes every region. One region failing must not stop the others — a
   * rollover in eu is worth catching even while us is timing out.
   */
  private async refreshAll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (const region of this.regions) {
        try {
          await this.seasons.refresh(region);
        } catch (error) {
          // `describeError`, so a malformed season payload stays one log line
          // instead of a multi-line JSON wall that log shipping splits apart.
          this.logger.error(
            `Could not refresh the season for ${region}: ${describeError(error)}`,
            errorStack(error),
          );
        }
      }

      // An unchanged season logs nothing, so say the check happened at all.
      this.logger.debug(`Season check complete for ${this.regions.join(', ')}`);
    } finally {
      this.running = false;
    }
  }
}
