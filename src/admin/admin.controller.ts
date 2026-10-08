import { Controller, Logger, NotFoundException, OnModuleInit, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Region } from '../blizzard/blizzard.constants.js';
import { RunKind, withRunId } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { ArchiveService } from '../archive/archive.service.js';
import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
import { MplusArchiveService } from '../mplus-archive/mplus-archive.service.js';
import { MplusCatalogueService } from '../mplus-season/mplus-catalogue.service.js';
import { MplusSeasonTransitionService } from '../mplus-season/mplus-season-transition.service.js';
import { MplusSeasonService } from '../mplus-season/mplus-season.service.js';
import { MplusService } from '../mplus/mplus.service.js';
import { ProfileEnrichmentService } from '../profile/profile-enrichment.service.js';
import { RaidCatalogueService } from '../raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../raid/raid-rankings.service.js';
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
    private readonly mplusTransitions: MplusSeasonTransitionService,
    private readonly raidCatalogue: RaidCatalogueService,
    private readonly raidRankings: RaidRankingsService,
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

  @Post(RunKind.Sweep)
  async sweep() {
    this.guard();

    return (await this.leaderboards.sweep()) ?? { skipped: 'a sweep is already in progress' };
  }

  @Post(RunKind.Enrich)
  async enrich() {
    this.guard();

    return (
      (await this.enrichment.run()) ?? { skipped: 'enrichment is running or deferred to a sweep' }
    );
  }

  @Post(RunKind.Snapshot)
  async snapshot() {
    this.guard();

    return this.representation.snapshot();
  }

  @Post(RunKind.Archive)
  async archiveOne() {
    this.guard();

    // Charged to the archive's share like a scheduled pass, so a rehearsal
    // driven from here sees the same budget the scheduler would.
    return withRunId(RunKind.Archive, async () => {
      const pending = await this.archive.nextPending();

      if (!pending) return { archived: null, reason: 'nothing pending' };

      return this.archive.archiveSeason(pending.seasonId, pending.region);
    });
  }

  /** Fetches the rewards for every archived season that lacks them. */
  @Post('archive-rewards')
  async archiveRewards() {
    this.guard();

    return withRunId(RunKind.Archive, () => this.archive.archivePendingRewards());
  }

  /**
   * One full Mythic+ pass. Minutes long at the defaults — ~1,001 requests a
   * region — so drive it with `RAIDERIO_MAX_PAGES` lowered unless a full
   * rehearsal is the point.
   */
  @Post(RunKind.Mplus)
  async mplusSweep() {
    this.guard();

    // `sweep` establishes its own run id, so a rehearsal driven from here is
    // charged to the Raider.io budget exactly as a scheduled pass is.
    return (await this.mplus.sweep()) ?? { skipped: 'a Mythic+ pass is already in progress' };
  }

  /**
   * Re-reads the season catalogue now, ignoring its TTL, then observes which
   * season is current in each region — announcing an end or a rollover exactly
   * as the scheduled check would.
   */
  @Post(RunKind.MplusSeason)
  async mplusSeason() {
    this.guard();

    return withRunId(RunKind.MplusSeason, async () => {
      const catalogue = await this.mplusCatalogue.refresh();
      await this.mplusSeasons.observe();

      return { catalogue, seasons: this.mplusSeasons.describe() };
    });
  }

  /** Plans and runs the Mythic+ season transition, honouring its dry-run flag. */
  @Post('mplus-season-transition')
  async mplusSeasonTransition() {
    this.guard();

    return withRunId(RunKind.Transition, () => this.mplusTransitions.run());
  }

  /**
   * One Mythic+ archive tick: catalogue if due, then the backlog. Driven
   * directly, so it runs whatever else is active — a rehearsal is the point.
   * It still yields between batches if a higher-priority job starts.
   */
  @Post(RunKind.MplusArchive)
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

    return withRunId(RunKind.MplusSeason, () => this.mplusCatalogue.refresh());
  }

  /** Re-reads the raid catalogue now, ignoring its TTL. */
  @Post(RunKind.RaidCatalogue)
  async raidCatalogueRefresh() {
    this.guard();

    return withRunId(RunKind.RaidCatalogue, () => this.raidCatalogue.refresh());
  }

  /**
   * Reads the raid boards that are due, as a scheduled run would. With
   * `?raid=<slug>` it re-reads every board of that one raid instead, due or
   * not — the only way a finished raid's settled board is read again.
   */
  @Post(RunKind.RaidRankings)
  async raidRankingsRefresh(@Query('raid') raid?: string) {
    this.guard();

    return withRunId(RunKind.RaidRankings, async () => {
      if (!raid) return this.raidRankings.refreshDue();

      const result = await this.raidRankings.refreshRaid(raid);
      if (!result) throw new NotFoundException(`The raid catalogue lists no raid "${raid}"`);

      return result;
    });
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
