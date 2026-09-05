import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { SweepEvents } from '../common/events/sweep-events.service.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { Env } from '../config/env.schema.js';
import { ProfileEnrichmentService } from './profile-enrichment.service.js';
import type { Subscription } from 'rxjs';

const INTERVAL_NAME = 'profile-enrichment';

/** Drives enrichment on its own cadence, independent of the leaderboard sweep. */
@Injectable()
export class ProfileScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProfileScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private subscription?: Subscription;

  constructor(
    config: ConfigService<Env, true>,
    private readonly enrichment: ProfileEnrichmentService,
    private readonly scheduler: SchedulerRegistry,
    private readonly sweeps: SweepEvents,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.enabled = config.get('PROFILE_ENRICHMENT_ENABLED', { infer: true });
    this.intervalMs = config.get('PROFILE_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Profile enrichment disabled');
      // Otherwise the archive waits forever for a pass that never comes.
      this.coordinator.markEnrichmentDisabled();
      return;
    }

    const interval = setInterval(() => void this.run(), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Profile enrichment scheduled every ${this.intervalMs}ms`);

    // A finished sweep may have added characters; enrich just those right away.
    this.subscription = this.sweeps.completed$.subscribe(() => void this.run(true));
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async run(onlyNew = false): Promise<void> {
    try {
      await this.enrichment.run(onlyNew);
    } catch (error) {
      this.logger.error('Unhandled error during profile enrichment', error as Error);
    }
  }
}
