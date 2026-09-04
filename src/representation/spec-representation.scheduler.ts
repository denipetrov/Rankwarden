import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import { SweepEvents } from '../common/events/sweep-events.service.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { Env } from '../config/env.schema.js';
import { SpecRepresentationService } from './spec-representation.service.js';
import type { Subscription } from 'rxjs';

const INTERVAL_NAME = 'spec-representation';

/**
 * Takes one snapshot per UTC day for as long as a season is running.
 *
 * Implemented as a frequent check for "is today's snapshot missing" rather than
 * a fixed daily alarm, so a day is not silently lost to a restart or to the
 * process being down at the wrong moment.
 */
@Injectable()
export class SpecRepresentationScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SpecRepresentationScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private subscription?: Subscription;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly representation: SpecRepresentationService,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
    private readonly sweeps: SweepEvents,
  ) {
    this.enabled = config.get('REPRESENTATION_ENABLED', { infer: true });
    this.intervalMs = config.get('REPRESENTATION_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Spec representation snapshots disabled');
      return;
    }

    const interval = setInterval(() => void this.tick(), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Checking for a missing daily snapshot every ${this.intervalMs}ms`);

    // A snapshot taken right after a sweep sees the freshest ladder, and this is
    // also what catches the startup case: the bootstrap tick below runs while
    // the startup sweep holds the coordinator, so it always defers.
    this.subscription = this.sweeps.completed$.subscribe(() => void this.tick());

    void this.tick();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;

    // Counting mid-sweep would sample a half-written ladder. The sweep-completed
    // subscription brings us straight back, so nothing is lost by returning.
    if (this.coordinator.isSweepActive) {
      this.logger.log('Ladder sweep in progress, deferring snapshot');
      return;
    }

    this.running = true;

    try {
      if (await this.representation.hasSnapshotFor(new Date())) return;

      await this.representation.snapshot();
    } catch (error) {
      this.logger.error('Failed to write the daily representation snapshot', error as Error);
    } finally {
      this.running = false;
    }
  }
}
