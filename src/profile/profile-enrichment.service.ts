import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ProfileApi } from '../blizzard/profile.api.js';
import { activeLoadoutsBySpec } from '../blizzard/schemas/character-profile.schema.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { RateLimiter } from '../common/utils/rate-limiter.js';
import type { Env } from '../config/env.schema.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import type { CharacterDocument } from '../leaderboard/entities/character.entity.js';

type Outcome = 'ok' | 'missing' | 'failed' | 'skipped';

export interface EnrichmentRunResult {
  selected: number;
  enriched: number;
  missing: number;
  failed: number;
  skipped: number;
  requests: number;
  durationMs: number;
}

/**
 * Fills in race, class, realm, title, spec and hero talent tree for characters
 * already on the ladders.
 *
 * The two source endpoints are refreshed on separate schedules — the summary
 * changes rarely, specs follow respecs — so a pass fetches only the halves that
 * are actually due. It also yields to the leaderboard sweep, which writes the
 * same documents and draws on the same API quota.
 */
@Injectable()
export class ProfileEnrichmentService {
  private readonly logger = new Logger(ProfileEnrichmentService.name);
  private readonly batchSize: number;
  private readonly summaryTtlMs: number;
  private readonly specsTtlMs: number;
  private readonly concurrency: number;
  private readonly limiter: RateLimiter;
  private running = false;
  private requests = 0;

  constructor(
    config: ConfigService<Env, true>,
    private readonly profileApi: ProfileApi,
    private readonly characters: CharacterRepository,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.batchSize = config.get('PROFILE_BATCH_SIZE', { infer: true });
    this.summaryTtlMs = config.get('PROFILE_SUMMARY_TTL_MS', { infer: true });
    this.specsTtlMs = config.get('PROFILE_SPECS_TTL_MS', { infer: true });
    this.concurrency = config.get('PROFILE_CONCURRENCY', { infer: true });
    this.limiter = new RateLimiter(config.get('PROFILE_REQUESTS_PER_SECOND', { infer: true }));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Enriches up to one batch. `onlyNew` limits the pass to characters a sweep
   * has just added, leaving the TTL refresh to the scheduled runs.
   */
  async run(onlyNew = false): Promise<EnrichmentRunResult | null> {
    if (this.running) {
      this.logger.warn('Enrichment already in progress, skipping this tick');
      return null;
    }

    if (this.coordinator.isSweepActive) {
      this.logger.log('Ladder sweep in progress, deferring enrichment');
      return null;
    }

    this.running = true;
    this.requests = 0;
    const startedAt = Date.now();

    try {
      const due = await this.characters.findProfilesToEnrich(
        new Date(startedAt - this.summaryTtlMs),
        new Date(startedAt - this.specsTtlMs),
        this.batchSize,
        onlyNew,
      );

      if (due.length === 0) {
        this.logger.debug(`No ${onlyNew ? 'new ' : ''}characters due for enrichment`);
        return this.emptyResult();
      }

      const outcomes = await mapWithConcurrency(due, this.concurrency, (character) =>
        this.enrich(character, startedAt),
      );

      const count = (outcome: Outcome) => outcomes.filter((value) => value === outcome).length;
      const result: EnrichmentRunResult = {
        selected: due.length,
        enriched: count('ok'),
        missing: count('missing'),
        failed: count('failed'),
        skipped: count('skipped'),
        requests: this.requests,
        durationMs: Date.now() - startedAt,
      };

      this.logger.log(
        `Enriched ${result.enriched}/${result.selected}${onlyNew ? ' new' : ''} characters ` +
          `in ${result.durationMs}ms using ${result.requests} requests ` +
          `(${result.missing} missing, ${result.failed} failed, ${result.skipped} skipped)`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  private emptyResult(): EnrichmentRunResult {
    return {
      selected: 0,
      enriched: 0,
      missing: 0,
      failed: 0,
      skipped: 0,
      requests: 0,
      durationMs: 0,
    };
  }

  private isDue(fetchedAt: Date | undefined, ttlMs: number, now: number): boolean {
    return fetchedAt === undefined || now - fetchedAt.getTime() >= ttlMs;
  }

  private async enrich(character: CharacterDocument, startedAt: number): Promise<Outcome> {
    // A sweep that started mid-pass takes priority; stop between characters.
    if (this.coordinator.isSweepActive) {
      return 'skipped';
    }

    const { seasonId, region, characterId, realmSlug, characterName } = character;
    const summaryDue = this.isDue(character.profileFetchedAt, this.summaryTtlMs, startedAt);
    const specsDue = this.isDue(character.specsFetchedAt, this.specsTtlMs, startedAt);

    try {
      if (summaryDue) {
        const fetchedAt = new Date();
        this.requests += 1;
        await this.limiter.acquire();
        const summary = await this.profileApi.getProfile(region, realmSlug, characterName);

        if (summary === null) {
          await this.characters.markProfileMissing(seasonId, region, characterId, fetchedAt);
          return 'missing';
        }

        await this.characters.saveProfileSummary(
          seasonId,
          region,
          characterId,
          {
            race: summary.race,
            class: summary.character_class,
            level: summary.level,
            gender: summary.gender?.type ?? null,
            guild: summary.guild ?? null,
            realmName: summary.realm.name,
            title: summary.active_title?.display_string ?? null,
            averageItemLevel: summary.average_item_level ?? null,
            equippedItemLevel: summary.equipped_item_level ?? null,
            lastLoginAt: summary.last_login_timestamp
              ? new Date(summary.last_login_timestamp)
              : null,
          },
          fetchedAt,
        );
      }

      if (specsDue) {
        const fetchedAt = new Date();
        this.requests += 1;
        await this.limiter.acquire();
        const specializations = await this.profileApi.getSpecializations(
          region,
          realmSlug,
          characterName,
        );

        // Stamp the timestamp either way, so a 404 here cannot hot-loop.
        await this.characters.saveProfileSpecs(
          seasonId,
          region,
          characterId,
          {
            spec: specializations?.active_specialization ?? null,
            heroTalentTree: specializations?.active_hero_talent_tree ?? null,
            talentLoadouts: specializations ? activeLoadoutsBySpec(specializations) : [],
          },
          fetchedAt,
        );
      }

      return 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Enrichment failed for ${region}/${realmSlug}/${characterName}: ${message}`);
      return 'failed';
    }
  }
}
