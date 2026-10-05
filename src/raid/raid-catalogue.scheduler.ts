import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { withRunId } from '../common/logging/run-context.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { RaidCatalogueService } from './raid-catalogue.service.js';

const INTERVAL_NAME = 'raid-catalogue-check';

/**
 * Keeps the raid catalogue loaded, on its own schedule: a tick at bootstrap,
 * then one per interval. A tick costs no request while the catalogue is inside
 * its TTL, so the interval is only how late a new raid or a real end date is
 * noticed.
 *
 * It waits on nothing and nothing waits on it: six small requests and thirty
 * small writes do not compete with a sweep, so it takes no part in the
 * ingestion coordinator's ordering.
 */
@Injectable()
export class RaidCatalogueScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RaidCatalogueScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly catalogue: RaidCatalogueService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.enabled = config.get('RAID_CATALOGUE_ENABLED', { infer: true });
    this.intervalMs = config.get('RAID_CATALOGUE_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Raid catalogue disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Checking the raid catalogue every ${this.intervalMs}ms`);

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
      await withRunId('raid-catalogue', () => this.catalogue.refreshIfDue());
    } catch (error) {
      this.logger.error(
        `Could not check the raid catalogue: ${describeError(error)}`,
        errorStack(error),
      );
    } finally {
      this.running = false;
    }
  }
}
