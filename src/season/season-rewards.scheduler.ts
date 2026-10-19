import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RunLogger, withRunId } from '@denipetrov/spirit-link/logging';
import type { Subscription } from 'rxjs';

import { isIngestableBracket, type Region } from '../blizzard/blizzard.constants.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { SweepEvents } from '../common/events/sweep-events.service.js';
import { RunKind } from '../common/logging/run-kind.js';
import { PendingWork } from '../common/pending-work.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { SeasonRewardsService } from '../rewards/season-rewards.service.js';
import { SeasonStateRepository } from './season-state.repository.js';
import { SeasonService } from './season.service.js';

/**
 * Keeps the current season's titles and rating cutoffs on \`season_state\`, so a
 * reader can show who would earn a title if the season ended now.
 *
 * A finished season's cutoffs are recorded once, by the archive. The running
 * season's move with its ladders — Blizzard recomputes them as ratings change —
 * so they are re-read after every sweep, when the standings they are compared
 * with have just been refreshed. That is one request per region an hour; the
 * bracket list comes from the sweep's own cached read and the spec lookups are
 * shared with the archive, so neither costs anything after the first time.
 *
 * Nothing is lost when a read fails: the last cutoffs read for the same season
 * stay in place, and the next sweep tries again. A rollover clears them (see
 * \`SeasonStateRepository.save\`), so a new season never shows the old one's.
 */
@Injectable()
export class SeasonRewardsScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new RunLogger(SeasonRewardsScheduler.name);
  private readonly regions: Region[];
  private readonly enabled: boolean;
  private readonly pending = new PendingWork();
  private subscription?: Subscription;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly seasons: SeasonService,
    private readonly state: SeasonStateRepository,
    private readonly pvpApi: PvpApi,
    private readonly seasonRewards: SeasonRewardsService,
    private readonly sweeps: SweepEvents,
  ) {
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
    this.enabled = config.get('SEASON_REWARDS_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      new Logger(SeasonRewardsScheduler.name).log('Current-season rewards disabled');
      return;
    }

    this.subscription = this.sweeps.completed$.subscribe(() =>
      this.pending.run(() => this.refreshAll()),
    );
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** Test seam: the refresh after a sweep is fire-and-forget in production. */
  whenSettled(): Promise<void> {
    return this.pending.whenSettled();
  }

  /**
   * Reads every region's current-season rewards. One region failing does not
   * stop the others, and a refresh already running is not doubled.
   */
  async refreshAll(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await withRunId(RunKind.SeasonRewards, async () => {
        for (const region of this.regions) {
          await this.refresh(region);
        }
      });
    } finally {
      this.running = false;
    }
  }

  private async refresh(region: Region): Promise<void> {
    const season = this.seasons.getObserved(region);
    if (!season) return;

    try {
      const ladders = (await this.pvpApi.getBrackets(region, season.id)).filter(
        isIngestableBracket,
      );
      const { rewards, unmatched } = await this.seasonRewards.fetch(region, season.id, ladders);

      if (unmatched.length > 0) {
        this.logger.warn(
          `Season ${season.id} ${region}: ${unmatched.length} reward(s) match no published ` +
            `ladder and were not recorded: ${unmatched.join('; ')}`,
        );
      }

      const recorded = await this.state.recordRewards(region, season.id, rewards, new Date());

      // Only possible if the season rolled over while this was reading: the
      // cutoffs belong to the season that just ended, so they are not kept.
      if (!recorded) {
        this.logger.warn(`Season ${season.id} ${region} is no longer current; rewards not kept`);
        return;
      }

      this.logger.log(`Season ${season.id} ${region}: ${rewards.length} reward cutoffs recorded`);
    } catch (error) {
      // A season's first days can answer 404 before Blizzard publishes cutoffs.
      this.logger.warn(
        `Could not read the rewards for season ${season.id} ${region}: ${describeError(error)}; ` +
          'keeping the last ones read, retrying after the next sweep',
      );
    }
  }
}
