import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { withRunId } from '../common/logging/run-context.js';
import { PendingWork } from '../common/pending-work.js';
import { errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MplusSeasonEvents } from './mplus-season-events.service.js';
import { MplusSeasonTransitionService } from './mplus-season-transition.service.js';

const INTERVAL_NAME = 'mplus-season-transition';

/**
 * Retires superseded Mythic+ seasons on an interval, and straight after a
 * rollover. The counterpart of `SeasonTransitionScheduler`.
 *
 * A rollover is most often noticed by a live pass, which observes the season
 * before its first page — so the tick it triggers would find that very pass
 * running and abstain. The tick therefore waits for the pass to finish rather
 * than giving up, and runs the moment it does.
 */
@Injectable()
export class MplusSeasonTransitionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MplusSeasonTransitionScheduler.name);
  private readonly enabled: boolean;
  private readonly archiveEnabled: boolean;
  private readonly intervalMs: number;
  private subscription?: Subscription;
  private readonly pending = new PendingWork();
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly transitions: MplusSeasonTransitionService,
    private readonly events: MplusSeasonEvents,
    private readonly scheduler: SchedulerRegistry,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.enabled = config.get('MPLUS_TRANSITION_ENABLED', { infer: true });
    this.archiveEnabled = config.get('MPLUS_ARCHIVE_ENABLED', { infer: true });
    this.intervalMs = config.get('MPLUS_TRANSITION_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Mythic+ season transitions disabled');
      return;
    }

    const interval = setInterval(() => this.pending.run(() => this.tick()), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `Checking for a Mythic+ season to retire every ${this.intervalMs}ms` +
        (this.transitions.isDryRun ? ' (dry run: nothing will be deleted)' : ''),
    );

    // Said once at boot rather than on every tick: with the interlock on and the
    // archive off, a superseded season is never retired, and the only sign of it
    // would otherwise be a plan nobody reads.
    if (this.transitions.requiresArchive && !this.archiveEnabled) {
      this.logger.warn(
        'MPLUS_PURGE_REQUIRE_ARCHIVE is on but MPLUS_ARCHIVE_ENABLED is off: superseded ' +
          'Mythic+ seasons will stay in the live collections until they are archived',
      );
    }

    this.subscription = this.events.transitions$.subscribe((event) => {
      if (event.kind !== 'rollover') return;

      this.logger.log(`Mythic+ rollover in ${event.region}; checking for seasons to retire`);
      this.pending.run(() => this.tick());
    });

    // No bootstrap tick, as on the PvP side: the first interval or the first
    // rollover is soon enough, and a boot-time purge would land before the
    // season check had confirmed the catalogue.
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
      await this.coordinator.whenMplusIdle();

      await withRunId('transition', async () => {
        const { plan, purged } = await this.transitions.run();

        if (purged.length > 0) {
          this.logger.log(
            `Retired ${purged.length} Mythic+ season/region pair(s)` +
              (plan.dryRun ? ' (dry run)' : '') +
              `: ${purged.map((entry) => `${entry.season}/${entry.region}`).join(', ')}`,
          );
        }
      });
    } catch (error) {
      this.logger.error('Mythic+ season transition check failed', errorStack(error));
    } finally {
      this.running = false;
    }
  }
}
