import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { withRunId } from '../common/logging/run-context.js';
import { PendingWork } from '../common/pending-work.js';
import { errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { SeasonEvents } from './season-events.service.js';
import { SeasonTransitionService } from './season-transition.service.js';

const INTERVAL_NAME = 'season-transition';

/**
 * Retires finished seasons on an interval, and immediately on a rollover.
 *
 * The interval is the fallback: a rollover event ticks straight away, so the
 * hourly pass only matters when the transition was first seen by some other
 * path — a restart that rehydrated persisted state, say, or an event nobody
 * was listening for yet.
 */
@Injectable()
export class SeasonTransitionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SeasonTransitionScheduler.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private subscription?: Subscription;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly transitions: SeasonTransitionService,
    private readonly events: SeasonEvents,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.enabled = config.get('SEASON_TRANSITION_ENABLED', { infer: true });
    this.intervalMs = config.get('SEASON_TRANSITION_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Season transitions disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `Checking for a season to retire every ${this.intervalMs}ms` +
        (this.transitions.isDryRun ? ' (dry run: nothing will be deleted)' : ''),
    );

    this.subscription = this.events.transitions$.subscribe((event) => {
      if (event.kind !== 'rollover') return;

      this.logger.log(`Rollover in ${event.region}; checking for seasons to retire`);
      this.pending.run(() => this.tick());
    });

    // Deliberately no bootstrap tick. A purge at boot would land before the
    // first season refresh has confirmed what is current, and `plan()` would
    // abstain anyway; the first interval or the first rollover is soon enough.
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();

    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  /** Test seam: rollover-driven ticks are fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await withRunId('transition', async () => {
        const { plan, purged } = await this.transitions.run();

        if (purged.length > 0) {
          this.logger.log(
            `Retired ${purged.length} season/region pair(s)` +
              (plan.dryRun ? ' (dry run)' : '') +
              `: ${purged.map((entry) => `${entry.seasonId}/${entry.region}`).join(', ')}`,
          );
        }
      });
    } catch (error) {
      this.logger.error('Season transition check failed', errorStack(error));
    } finally {
      this.running = false;
    }
  }
}
