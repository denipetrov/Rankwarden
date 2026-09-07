import { Controller, Logger, NotFoundException, OnModuleInit, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Region } from '../blizzard/blizzard.constants.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { ArchiveService } from '../archive/archive.service.js';
import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
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
    const pending = await this.archive.nextPending();

    if (!pending) return { archived: null, reason: 'nothing pending' };

    return this.archive.archiveSeason(pending.seasonId, pending.region);
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
