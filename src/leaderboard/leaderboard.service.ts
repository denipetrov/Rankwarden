import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  isIngestableBracket,
  ratingFamilyOf,
  type Bracket,
  type Region,
} from '../blizzard/blizzard.constants.js';
import { BlizzardApiError } from '../blizzard/http/blizzard-api.error.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { SweepEvents } from '../common/events/sweep-events.service.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RunLogger, withRunId } from '../common/logging/run-context.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { SeasonService } from '../season/season.service.js';
import { CharacterRepository } from './character.repository.js';
import { toCharacterBracketUpdates } from './leaderboard.mapper.js';
import { RatingRepository } from './rating.repository.js';

export interface SweepJobResult {
  region: Region;
  bracket: Bracket;
  seasonId: number | null;
  entries: number;
  written: number;
  droppedBrackets: number;
  error?: string;
  /** HTTP status when the failure came from the API; null otherwise. */
  status?: number | null;
}

export interface SweepResult {
  /** Correlation id shared by every log line this sweep produced. */
  runId: string;
  startedAt: Date;
  durationMs: number;
  jobs: SweepJobResult[];
  failed: number;
  /** Characters deleted because they no longer rank in any bracket. */
  removedCharacters: number;
  /** Failed brackets grouped by status code, for the closing summary. */
  failures: { status: string; brackets: Bracket[] }[];
}

/**
 * Orchestrates one full ingestion sweep: resolve the active season per region,
 * pull every bracket, and persist the flattened entries.
 */
@Injectable()
export class LeaderboardService {
  private readonly logger = new RunLogger(LeaderboardService.name);
  private readonly regions: Region[];
  private readonly concurrency: number;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly pvpApi: PvpApi,
    private readonly seasons: SeasonService,
    private readonly repository: CharacterRepository,
    private readonly ratings: RatingRepository,
    private readonly sweeps: SweepEvents,
    private readonly coordinator: IngestionCoordinator,
  ) {
    // Validated as regions at boot, so nothing is filtered out here: a typo in
    // the deployment config now fails validation instead of silently reducing
    // coverage to whatever happened to parse.
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
    this.concurrency = config.get('BLIZZARD_CONCURRENCY', { infer: true });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Runs a sweep unless one is already in flight (overlapping sweeps waste rate limit). */
  async sweep(): Promise<SweepResult | null> {
    if (this.running) {
      this.logger.warn('Sweep already in progress, skipping this tick');
      return null;
    }

    this.running = true;
    const startedAt = new Date();

    try {
      // Every line this run produces carries its id, so a retry warning buried
      // hundreds of lines up can still be tied back to the sweep it came from.
      const result = await withRunId('sweep', async (runId) =>
        // Held for the whole sweep so enrichment stays out of the way: it writes
        // the same documents and draws on the same hourly request quota.
        this.coordinator.duringSweep(async () => {
          const jobs = await this.buildJobs();
          const results = await mapWithConcurrency(jobs, this.concurrency, (job) =>
            this.ingestBracket(job.region, job.bracket, job.seasonId),
          );

          const failed = results.filter((result) => result.error).length;

          // Once per region, after every bracket has had its chance to re-rank
          // people. The season comes from the jobs rather than from SeasonService:
          // a rollover detected mid-sweep would otherwise have the cleanup act on
          // the new season while every write went to the old one.
          let removedCharacters = 0;
          let removedRatingRows = 0;
          let clearedBrackets = 0;
          const seasonByRegion = new Map(jobs.map((job) => [job.region, job.seasonId]));

          for (const [region, seasonId] of seasonByRegion) {
            const live = jobs.filter((job) => job.region === region).map((job) => job.bracket);

            // Retired ladders first: a character ranked only in brackets that no
            // longer exist has to reach an empty `brackets` map before the
            // unranked pass below can see them at all.
            clearedBrackets += await this.repository.removeRetiredBrackets(seasonId, region, live);
            removedCharacters += await this.repository.removeUnranked(seasonId, region);
            // Only after the characters are gone, so their rows are orphans by then.
            removedRatingRows += await this.ratings.removeOrphans(seasonId, region);
            removedRatingRows += await this.ratings.removeRetiredBrackets(seasonId, region, live);
          }

          const durationMs = Date.now() - startedAt.getTime();
          const failures = groupFailures(results);

          this.logger.log(
            `Sweep finished in ${durationMs}ms: ${results.length - failed}/${results.length} brackets ok, ` +
              `${clearedBrackets} retired brackets cleared, ${removedCharacters} characters unranked, ` +
              `${removedRatingRows} stale rating rows removed`,
          );

          // Which brackets failed, not only how many: with 332 brackets at
          // concurrency 8 the individual error lines are scattered hundreds of
          // lines above and interleaved with seven other jobs.
          for (const failure of failures) {
            this.logger.warn(
              `Failed ${failure.brackets.length} bracket(s) with ${failure.status}: ` +
                failure.brackets.join(', '),
            );
          }

          return {
            runId,
            startedAt,
            durationMs,
            jobs: results,
            failed,
            removedCharacters,
            failures,
          };
        }),
      );

      // Emitted only once the coordinator has released, otherwise the follow-up
      // enrichment pass sees a sweep still in progress and defers itself.
      this.sweeps.emitCompleted({
        finishedAt: new Date(),
        brackets: result.jobs.length,
        failed: result.failed,
        removedCharacters: result.removedCharacters,
      });

      return result;
    } finally {
      this.running = false;
    }
  }

  /** Resolves the active season per region and expands it into region x bracket jobs. */
  private async buildJobs(): Promise<{ region: Region; bracket: Bracket; seasonId: number }[]> {
    const jobs: { region: Region; bracket: Bracket; seasonId: number }[] = [];

    for (const region of this.regions) {
      try {
        const seasonId = await this.seasons.refresh(region);
        // Ask Blizzard which brackets exist rather than hardcoding them; the set
        // grows with every new specialisation.
        const brackets = await this.pvpApi.getBrackets(region, seasonId);
        const ingestable = brackets.filter(isIngestableBracket);

        if (ingestable.length !== brackets.length) {
          this.logger.debug(
            `${region}: skipping ${brackets.length - ingestable.length} aggregate brackets`,
          );
        }

        for (const bracket of ingestable) {
          jobs.push({ region, bracket, seasonId });
        }
      } catch (error) {
        // The stack, not the Error: Logger.error takes a string second
        // argument, and this is one of the outermost handlers in the service.
        this.logger.error(
          `Could not resolve brackets for ${region}: ${describeError(error)}`,
          errorStack(error),
        );
      }
    }

    return jobs;
  }

  private async ingestBracket(
    region: Region,
    bracket: Bracket,
    seasonId: number,
  ): Promise<SweepJobResult> {
    const fetchedAt = new Date();

    try {
      const leaderboard = await this.pvpApi.getLeaderboard(region, seasonId, bracket);

      // The payload names the season it describes. During a rollover a stale
      // edge cache or an early flip can serve one season under the other id,
      // and persisting it would file a whole ladder under the wrong season with
      // nothing downstream able to tell.
      if (leaderboard.season.id !== seasonId) {
        throw new Error(
          `season mismatch: requested ${seasonId}, payload describes ${leaderboard.season.id}`,
        );
      }

      const updates = toCharacterBracketUpdates(leaderboard, {
        region,
        bracket,
        seasonId,
        fetchedAt,
      });

      const written = await this.repository.upsertBracketEntries(updates);
      const droppedBrackets = await this.repository.pruneBracket(
        seasonId,
        region,
        bracket,
        fetchedAt,
      );

      // Every bracket is mirrored into its family's flat collection, which is
      // what the ordered boards are read from.
      const family = ratingFamilyOf(bracket);
      if (family) {
        await this.ratings.upsertBracket(family, updates);
        await this.ratings.pruneBracket(family, seasonId, region, bracket, fetchedAt);
      }

      return { region, bracket, seasonId, entries: updates.length, written, droppedBrackets };
    } catch (error) {
      // `describeError`, not `error.message`: a ZodError message is a
      // pretty-printed JSON array of every issue, so one malformed payload
      // would otherwise emit a multi-line block where a log line belongs, and
      // line-oriented shipping would split it into unrelated records.
      const message = describeError(error);
      this.logger.error(`Failed ingesting ${region}/${bracket}: ${message}`);

      return {
        region,
        bracket,
        seasonId,
        entries: 0,
        written: 0,
        droppedBrackets: 0,
        error: message,
        status: error instanceof BlizzardApiError ? error.statusCode : null,
      };
    }
  }
}

/** Groups failed jobs by status, so the closing summary names them once. */
function groupFailures(results: readonly SweepJobResult[]): {
  status: string;
  brackets: Bracket[];
}[] {
  const grouped = new Map<string, Bracket[]>();

  for (const result of results) {
    if (!result.error) continue;

    const key = result.status ? String(result.status) : 'no HTTP status';
    grouped.set(key, [...(grouped.get(key) ?? []), result.bracket]);
  }

  return [...grouped]
    .map(([status, brackets]) => ({ status, brackets }))
    .sort((left, right) => right.brackets.length - left.brackets.length);
}
