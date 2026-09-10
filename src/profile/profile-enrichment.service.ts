import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZodError } from 'zod';

import { ProfileApi } from '../blizzard/profile.api.js';
import {
  activeLoadoutsBySpec,
  type CharacterSpecializationsPayload,
} from '../blizzard/schemas/character-profile.schema.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RunLogger, withRunId } from '../common/logging/run-context.js';
import { HOUR_MS, QuotaBudget } from '../common/quota/quota-budget.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import { RateLimiter } from '../common/utils/rate-limiter.js';
import type { Env } from '../config/env.schema.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import type {
  CharacterDocument,
  NamedRef,
  SpecLoadout,
} from '../leaderboard/entities/character.entity.js';
import { projectCapacity } from './enrichment-capacity.js';

type Outcome = 'ok' | 'missing' | 'failed' | 'skipped';

/**
 * How far one run may run ahead of its even share of the hour. A run skipped
 * because a sweep held the coordinator can be made up on the next, without
 * letting a single run drain the whole hour's share in one burst.
 */
const CATCH_UP_FACTOR = 2;

/** What a run was allowed, and why. */
interface BatchPlan {
  dueCharacters: number;
  dueRequests: number;
  requestBudget: number;
  batch: number;
}

export interface EnrichmentRunResult {
  /** Correlation id shared by every log line this pass produced. */
  runId: string;
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
  private readonly logger = new RunLogger(ProfileEnrichmentService.name);
  private readonly batchSize: number;
  private readonly summaryTtlMs: number;
  private readonly specsTtlMs: number;
  private readonly concurrency: number;
  private readonly retryBackoffMs: number;
  private readonly intervalMs: number;
  private readonly limiter: RateLimiter;
  private running = false;
  private requests = 0;

  constructor(
    config: ConfigService<Env, true>,
    private readonly profileApi: ProfileApi,
    private readonly characters: CharacterRepository,
    private readonly coordinator: IngestionCoordinator,
    private readonly budget: QuotaBudget,
  ) {
    this.batchSize = config.get('PROFILE_BATCH_SIZE', { infer: true });
    this.intervalMs = config.get('PROFILE_INTERVAL_MS', { infer: true });
    this.summaryTtlMs = config.get('PROFILE_SUMMARY_TTL_MS', { infer: true });
    this.specsTtlMs = config.get('PROFILE_SPECS_TTL_MS', { infer: true });
    this.concurrency = config.get('PROFILE_CONCURRENCY', { infer: true });
    this.retryBackoffMs = config.get('PROFILE_RETRY_BACKOFF_MS', { infer: true });
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

    // Announced so the archive holds off: enrichment is live data and wins.
    return withRunId('enrich', (runId) =>
      this.coordinator
        .duringEnrichment(async () => {
          const summaryStaleBefore = new Date(startedAt - this.summaryTtlMs);
          const specsStaleBefore = new Date(startedAt - this.specsTtlMs);
          const plan = await this.planBatch(summaryStaleBefore, specsStaleBefore, onlyNew);

          if (plan.batch === 0) {
            if (plan.dueCharacters > 0) {
              // Work is waiting but the share is spent. Said plainly, because a
              // queue that is merely throttled and one that has stopped look
              // identical from the outside otherwise.
              this.logger.log(
                `${plan.dueCharacters} characters due but the enrichment share of the hourly ` +
                  'quota is spent; waiting for the window to roll',
              );
            } else {
              this.logger.debug(`No ${onlyNew ? 'new ' : ''}characters due for enrichment`);
            }

            return this.emptyResult(runId);
          }

          const due = await this.characters.findProfilesToEnrich(
            summaryStaleBefore,
            specsStaleBefore,
            plan.batch,
            onlyNew,
          );

          if (due.length === 0) {
            this.logger.debug(`No ${onlyNew ? 'new ' : ''}characters due for enrichment`);
            return this.emptyResult(runId);
          }

          const outcomes = await mapWithConcurrency(due, this.concurrency, (character) =>
            this.enrich(character, startedAt),
          );

          const count = (outcome: Outcome) => outcomes.filter((value) => value === outcome).length;
          const result: EnrichmentRunResult = {
            runId,
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
        })
        .finally(() => {
          this.running = false;
        }),
    );
  }

  /**
   * Sizes this run from what is due and what the hourly quota still allows.
   *
   * The batch used to be a fixed number, which was a ceiling rather than a
   * spend — a run only ever fetches what is due — but a ceiling that knew
   * nothing about the population or about the other jobs sharing the quota.
   * Here it is the smallest of three things:
   *
   * - the characters actually due;
   * - what the request budget buys, at the average cost of those characters —
   *   one request for specs alone, two when the summary is due as well;
   * - `PROFILE_BATCH_SIZE`, now only a safety ceiling on run length and memory.
   *
   * The request budget is the enrichment allowance from the shared quota,
   * paced to this run's even share of the hour with room to catch up. Pacing
   * keeps spend smooth for the sweep and archive; without it the first run of
   * a backlog would take the whole hour's share at once.
   */
  private async planBatch(
    summaryStaleBefore: Date,
    specsStaleBefore: Date,
    onlyNew: boolean,
  ): Promise<BatchPlan> {
    const demand = await this.characters.countEnrichmentDemand(
      summaryStaleBefore,
      specsStaleBefore,
      onlyNew,
    );

    const perRunPace = Math.ceil((this.budget.enrichmentShare * this.intervalMs) / HOUR_MS);
    const requestBudget = Math.min(
      this.budget.allowance('enrichment'),
      perRunPace * CATCH_UP_FACTOR,
    );
    const costPerCharacter = demand.characters > 0 ? demand.requests / demand.characters : 1;
    const batch = Math.max(
      0,
      Math.min(demand.characters, Math.floor(requestBudget / costPerCharacter), this.batchSize),
    );

    const plan: BatchPlan = {
      dueCharacters: demand.characters,
      dueRequests: demand.requests,
      requestBudget,
      batch,
    };

    await this.publishOutlook(plan);

    return plan;
  }

  /**
   * Records whether enrichment can keep up, for the health endpoint to report
   * without doing any database work of its own. A failure here must never cost
   * a run, so it is logged and swallowed.
   */
  private async publishOutlook(plan: BatchPlan): Promise<void> {
    try {
      const [population, oldest] = await Promise.all([
        this.characters.population(),
        this.characters.oldestSpecsRefresh(),
      ]);
      const oldestRefreshAgeMs = oldest ? Date.now() - oldest.getTime() : null;

      const projection = projectCapacity({
        population,
        specsTtlMs: this.specsTtlMs,
        summaryTtlMs: this.summaryTtlMs,
        enrichmentShare: this.budget.enrichmentShare,
        batchSize: this.batchSize,
        intervalMs: this.intervalMs,
        oldestRefreshAgeMs,
      });

      this.budget.publishEnrichmentOutlook({
        computedAt: new Date().toISOString(),
        population,
        dueCharacters: plan.dueCharacters,
        dueRequests: plan.dueRequests,
        requestBudget: plan.requestBudget,
        batch: plan.batch,
        oldestRefreshAgeMs,
        ...projection,
      });

      if (!projection.feasible) {
        this.logger.warn(
          `Enrichment cannot keep its TTLs: ${population} characters need ~${projection.demandPerHour} ` +
            `requests an hour, capacity is ${projection.capacityPerHour} (bound by the ` +
            `${projection.bindingConstraint}); sustainable up to ${projection.maxSustainablePopulation}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Could not compute the enrichment outlook: ${describeError(error)}`);
    }
  }

  private emptyResult(runId: string): EnrichmentRunResult {
    return {
      runId,
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
    // Which half is in flight, so a failure stamps the timestamp that actually
    // governs re-selection rather than guessing.
    let half: 'summary' | 'specs' = 'summary';

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
        half = 'specs';
        const fetchedAt = new Date();
        this.requests += 1;
        await this.limiter.acquire();
        const specializations = await this.profileApi.getSpecializations(
          region,
          realmSlug,
          characterName,
        );

        const loadouts = specializations ? activeLoadoutsBySpec(specializations) : [];

        // Stamp the timestamp either way, so a 404 here cannot hot-loop.
        await this.characters.saveProfileSpecs(
          seasonId,
          region,
          characterId,
          {
            spec: specializations?.active_specialization ?? null,
            heroTalentTree: activeHeroTalentTree(specializations, loadouts),
            talentLoadouts: loadouts,
          },
          fetchedAt,
        );
      }

      return 'ok';
    } catch (error) {
      await this.recordFailure(character, half, error);

      return 'failed';
    }
  }

  /**
   * Stamps the failing half so the character leaves the front of the queue.
   *
   * A schema failure is deterministic — the same payload will not start parsing
   * on the next pass — so it waits out the full TTL. Anything else is treated as
   * transient and retried after a short backoff, expressed by backdating the
   * timestamp to just short of the TTL rather than carrying another field and
   * another index for it.
   */
  private async recordFailure(
    character: CharacterDocument,
    half: 'summary' | 'specs',
    error: unknown,
  ): Promise<void> {
    const { seasonId, region, characterId, realmSlug, characterName } = character;
    const permanent = error instanceof ZodError;
    const ttlMs = half === 'summary' ? this.summaryTtlMs : this.specsTtlMs;
    const retryAfter = permanent ? new Date() : new Date(Date.now() - ttlMs + this.retryBackoffMs);

    this.logger.warn(
      `Enrichment ${half} failed for ${region}/${realmSlug}/${characterName}: ` +
        `${describeError(error)}; retrying after ${permanent ? 'the full TTL' : `${this.retryBackoffMs}ms`}`,
    );

    try {
      await this.characters.markProfileUnreadable(
        seasonId,
        region,
        characterId,
        half,
        retryAfter,
        permanent,
      );
    } catch (writeError) {
      // If even this write fails the character stays at the front of the queue,
      // so say so plainly rather than letting the starvation be silent.
      this.logger.error(
        `Could not record the enrichment failure for ${region}/${realmSlug}/${characterName}: ` +
          describeError(writeError),
        errorStack(writeError),
      );
    }
  }
}

/**
 * The active spec's hero talent tree.
 *
 * Blizzard reports it twice: once at the top level, and once on the active
 * loadout of each spec. The top-level field is optional, and when it is absent
 * the loadout still carries the answer — so falling back keeps hero talent
 * coverage for the core brackets, whose representation counts read this field
 * rather than a loadout. The two were verified to agree, so the fallback cannot
 * contradict the primary source.
 */
function activeHeroTalentTree(
  payload: CharacterSpecializationsPayload | null,
  loadouts: readonly SpecLoadout[],
): NamedRef | null {
  if (!payload) return null;
  if (payload.active_hero_talent_tree) return payload.active_hero_talent_tree;

  const activeSpecId = payload.active_specialization?.id;
  if (activeSpecId === undefined) return null;

  return loadouts.find((loadout) => loadout.spec.id === activeSpecId)?.heroTalentTree ?? null;
}
