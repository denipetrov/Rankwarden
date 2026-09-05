import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
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
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly archive: ArchiveService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
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

    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);

    // Deliberately no tick here. The archive is the lowest priority work in the
    // service, so it waits for the first sweep and the first enrichment pass to
    // finish rather than competing with them for the quota while the live data
    // is still being filled in.
    this.logger.log(
      `Archiving will start once live ingestion has warmed up, then every ${this.intervalMs}ms`,
    );
    this.subscription = this.coordinator.warmedUp$.subscribe(() => void this.tick());
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

    try {
      for (;;) {
        // Re-checked between seasons: a sweep or enrichment pass starting mid
        // backlog takes the quota back immediately.
        if (this.coordinator.isLiveIngestionActive) {
          this.logger.log('Live ingestion in progress, pausing the archive');
          return;
        }

        const pending = await this.archive.nextPending();
        if (!pending) return;

        await this.archive.archiveSeason(pending.seasonId, pending.region);
        await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
      }
    } catch (error) {
      this.logger.error('Archiving failed', error as Error);
    } finally {
      this.running = false;
    }
  }
}
