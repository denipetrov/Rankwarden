import { Controller, Logger, NotFoundException, OnModuleInit, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Region } from '../blizzard/blizzard.constants.js';
import { withRunId } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { ArchiveService } from '../archive/archive.service.js';
import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
import { MplusSeasonService } from '../mplus/mplus-season.service.js';
import { MplusArchiveService } from '../mplus-archive/mplus-archive.service.js';
import { MplusCatalogueService } from '../mplus-archive/mplus-catalogue.service.js';
import { MplusService } from '../mplus/mplus.service.js';
import { ProfileEnrichmentService } from '../profile/profile-enrichment.service.js';
import { SpecRepresentationService } from '../representation/spec-representation.service.js';
import { SeasonService } from '../season/season.service.js';
import { SeasonTransitionService } from '../season/season-transition.service.js';

/**
 * Drives one cycle of each background job on demand, for runtime rehearsals.
 *
 * The alternative is shrinking the intervals through configuration, but the
 * season refresh runs daily and the sweep hourly, so compressing them enough to
 * observe anything makes every job race every other one — and a rehearsal stops
 * being a controlled observation. Each route here drives exactly one cycle and
 * hands back that cycle's own result object.
 *
 * Every route 404s outside development, because they are unauthenticated and
 * two of them delete data.
 */
@Controller('admin')
export class AdminController implements OnModuleInit {
  private readonly logger = new Logger(AdminController.name);
  private readonly enabled: boolean;
  private readonly regions: Region[];

  constructor(
    config: ConfigService<Env, true>,
    private readonly leaderboards: LeaderboardService,
    private readonly enrichment: ProfileEnrichmentService,
    private readonly representation: SpecRepresentationService,
    private readonly archive: ArchiveService,
    private readonly seasons: SeasonService,
    private readonly transitions: SeasonTransitionService,
    private readonly mplus: MplusService,
    private readonly mplusSeasons: MplusSeasonService,
    private readonly mplusArchive: MplusArchiveService,
    private readonly mplusCatalogue: MplusCatalogueService,
  ) {
    this.enabled = config.get('NODE_ENV', { infer: true }) !== 'production';
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.logger.warn(
        'Dev-only job triggers are mounted at POST /admin/*; they are disabled in production',
      );
    }
  }

  @Post('sweep')
  async sweep() {
    this.guard();

    return (await this.leaderboards.sweep()) ?? { skipped: 'a sweep is already in progress' };
  }

  @Post('enrich')
  async enrich() {
    this.guard();

    return (
      (await this.enrichment.run()) ?? { skipped: 'enrichment is running or deferred to a sweep' }
    );
  }

  @Post('snapshot')
  async snapshot() {
    this.guard();

    return this.representation.snapshot();
  }

  @Post('archive')
  async archiveOne() {
    this.guard();

    // Charged to the archive's share like a scheduled pass, so a rehearsal
    // driven from here sees the same budget the scheduler would.
    return withRunId('archive', async () => {
      const pending = await this.archive.nextPending();

      if (!pending) return { archived: null, reason: 'nothing pending' };

      return this.archive.archiveSeason(pending.seasonId, pending.region);
    });
  }

  /** Fetches the rewards for every archived season that lacks them. */
  @Post('archive-rewards')
  async archiveRewards() {
    this.guard();

    return withRunId('archive', () => this.archive.archivePendingRewards());
  }

  /**
   * One full Mythic+ pass. Minutes long at the defaults — ~1,001 requests a
   * region — so drive it with `RAIDERIO_MAX_PAGES` lowered unless a full
   * rehearsal is the point.
   */
  @Post('mplus')
  async mplusSweep() {
    this.guard();

    // `sweep` establishes its own run id, so a rehearsal driven from here is
    // charged to the Raider.io budget exactly as a scheduled pass is.
    return (await this.mplus.sweep()) ?? { skipped: 'a Mythic+ pass is already in progress' };
  }

  /** Re-reads which Mythic+ season is current, bypassing the cached answer. */
  @Post('mplus-season')
  async mplusSeason() {
    this.guard();
    this.mplusSeasons.invalidate();

    return withRunId('mplus', () => this.mplusSeasons.current());
  }

  /**
   * One Mythic+ archive tick: catalogue if due, then the backlog. Driven
   * directly, so it runs whatever else is active — a rehearsal is the point.
   * It still yields between batches if a higher-priority job starts.
   */
  @Post('mplus-archive')
  async mplusArchiveTick() {
    this.guard();

    return (
      (await this.mplusArchive.archiveBacklog()) ?? {
        skipped: 'a Mythic+ archive tick is already in progress',
      }
    );
  }

  /** Re-reads the season and dungeon catalogue now, ignoring its TTL. */
  @Post('mplus-catalogue')
  async mplusCatalogueRefresh() {
    this.guard();

    return withRunId('mplus-archive', () => this.mplusCatalogue.refresh());
  }

  @Post('season-refresh')
  async seasonRefresh() {
    this.guard();
    const seasons: Record<string, number | string> = {};

    // Per region rather than through the scheduler: its `refreshAll` is private,
    // and widening it to expose a test hook would be the wrong trade.
    for (const region of this.regions) {
      try {
        seasons[region] = await this.seasons.refresh(region);
      } catch (error) {
        seasons[region] = describeError(error);
      }
    }

    return { seasons, state: this.seasons.describe() };
  }

  @Post('season-transition')
  async seasonTransition() {
    this.guard();

    return this.transitions.run();
  }

  /** Hides the whole controller outside development, as if it were never mounted. */
  private guard(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}
