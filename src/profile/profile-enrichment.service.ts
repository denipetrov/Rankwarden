import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProfileApi } from '../blizzard/profile.api.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { RateLimiter } from '../common/utils/rate-limiter.js';
import type { Env } from '../config/env.schema.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import type {
  CharacterDocument,
  CharacterProfile,
} from '../leaderboard/entities/character.entity.js';

export interface EnrichmentRunResult {
  selected: number;
  enriched: number;
  missing: number;
  failed: number;
  durationMs: number;
}

/**
 * Fills in race, class, spec and hero talent tree for characters already on the
 * ladders. Each character costs two API requests, so this runs as its own
 * budgeted pass — oldest profiles first — rather than inside the sweep.
 */
@Injectable()
export class ProfileEnrichmentService {
  private readonly logger = new Logger(ProfileEnrichmentService.name);
  private readonly batchSize: number;
  private readonly ttlMs: number;
  private readonly concurrency: number;
  private readonly limiter: RateLimiter;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly profileApi: ProfileApi,
    private readonly characters: CharacterRepository,
  ) {
    this.batchSize = config.get('PROFILE_BATCH_SIZE', { infer: true });
    this.ttlMs = config.get('PROFILE_TTL_MS', { infer: true });
    this.concurrency = config.get('PROFILE_CONCURRENCY', { infer: true });
    this.limiter = new RateLimiter(config.get('PROFILE_REQUESTS_PER_SECOND', { infer: true }));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Enriches up to one batch. `onlyNew` limits the pass to characters a sweep
   * has just added, leaving the daily TTL refresh to the scheduled runs.
   */
  async run(onlyNew = false): Promise<EnrichmentRunResult | null> {
    if (this.running) {
      this.logger.warn('Enrichment already in progress, skipping this tick');
      return null;
    }

    this.running = true;
    const startedAt = Date.now();

    try {
      const staleBefore = new Date(startedAt - this.ttlMs);
      const due = await this.characters.findProfilesToEnrich(staleBefore, this.batchSize, onlyNew);

      if (due.length === 0) {
        this.logger.debug(`No ${onlyNew ? 'new ' : ''}characters due for enrichment`);
        return { selected: 0, enriched: 0, missing: 0, failed: 0, durationMs: 0 };
      }

      const outcomes = await mapWithConcurrency(due, this.concurrency, (character) =>
        this.enrich(character),
      );

      const result: EnrichmentRunResult = {
        selected: due.length,
        enriched: outcomes.filter((outcome) => outcome === 'ok').length,
        missing: outcomes.filter((outcome) => outcome === 'missing').length,
        failed: outcomes.filter((outcome) => outcome === 'failed').length,
        durationMs: Date.now() - startedAt,
      };

      this.logger.log(
        `Enriched ${result.enriched}/${result.selected}${onlyNew ? ' new' : ''} characters in ` +
          `${result.durationMs}ms (${result.missing} missing, ${result.failed} failed)`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  private async enrich(character: CharacterDocument): Promise<'ok' | 'missing' | 'failed'> {
    const { seasonId, region, characterId, realmSlug, characterName } = character;
    const fetchedAt = new Date();

    try {
      await this.limiter.acquire();
      const summary = await this.profileApi.getProfile(region, realmSlug, characterName);

      if (summary === null) {
        await this.characters.markProfileMissing(seasonId, region, characterId, fetchedAt);
        return 'missing';
      }

      await this.limiter.acquire();
      const specializations = await this.profileApi.getSpecializations(
        region,
        realmSlug,
        characterName,
      );

      const profile: CharacterProfile = {
        race: summary.race,
        class: summary.character_class,
        spec: specializations?.active_specialization ?? summary.active_spec ?? null,
        heroTalentTree: specializations?.active_hero_talent_tree ?? null,
        level: summary.level,
        gender: summary.gender?.type ?? null,
        guild: summary.guild ?? null,
        averageItemLevel: summary.average_item_level ?? null,
        equippedItemLevel: summary.equipped_item_level ?? null,
        lastLoginAt: summary.last_login_timestamp ? new Date(summary.last_login_timestamp) : null,
      };

      await this.characters.saveProfile(seasonId, region, characterId, profile, fetchedAt);
      return 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Enrichment failed for ${region}/${realmSlug}/${characterName}: ${message}`);
      return 'failed';
    }
  }
}
