import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BRACKETS, isRegion, type Bracket, type Region } from '../blizzard/blizzard.constants.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { SweepEvents } from '../common/events/sweep-events.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import type { Env } from '../config/env.schema.js';
import { SeasonService } from '../season/season.service.js';
import { CharacterRepository } from './character.repository.js';
import { toCharacterBracketUpdates } from './leaderboard.mapper.js';

export interface SweepJobResult {
  region: Region;
  bracket: Bracket;
  seasonId: number | null;
  entries: number;
  written: number;
  droppedBrackets: number;
  removedCharacters: number;
  error?: string;
}

export interface SweepResult {
  startedAt: Date;
  durationMs: number;
  jobs: SweepJobResult[];
  failed: number;
}

/**
 * Orchestrates one full ingestion sweep: resolve the active season per region,
 * pull every bracket, and persist the flattened entries.
 */
@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);
  private readonly regions: Region[];
  private readonly concurrency: number;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly pvpApi: PvpApi,
    private readonly seasons: SeasonService,
    private readonly repository: CharacterRepository,
    private readonly sweeps: SweepEvents,
  ) {
    this.regions = config
      .get('BLIZZARD_REGIONS', { infer: true })
      .filter((region): region is Region => isRegion(region));
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
      const jobs = await this.buildJobs();
      const results = await mapWithConcurrency(jobs, this.concurrency, (job) =>
        this.ingestBracket(job.region, job.bracket, job.seasonId),
      );

      const failed = results.filter((result) => result.error).length;
      const durationMs = Date.now() - startedAt.getTime();

      this.logger.log(
        `Sweep finished in ${durationMs}ms: ${results.length - failed}/${results.length} brackets ok`,
      );

      this.sweeps.emitCompleted({
        finishedAt: new Date(),
        brackets: results.length,
        failed,
      });

      return { startedAt, durationMs, jobs: results, failed };
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
        for (const bracket of BRACKETS) {
          jobs.push({ region, bracket, seasonId });
        }
      } catch (error) {
        this.logger.error(`Could not resolve active season for ${region}`, error as Error);
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
      const updates = toCharacterBracketUpdates(leaderboard, {
        region,
        bracket,
        seasonId,
        fetchedAt,
      });

      const written = await this.repository.upsertBracketEntries(updates);
      const { droppedBrackets, removedCharacters } = await this.repository.pruneBracket(
        seasonId,
        region,
        bracket,
        fetchedAt,
      );

      return {
        region,
        bracket,
        seasonId,
        entries: updates.length,
        written,
        droppedBrackets,
        removedCharacters,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed ingesting ${region}/${bracket}: ${message}`);

      return {
        region,
        bracket,
        seasonId,
        entries: 0,
        written: 0,
        droppedBrackets: 0,
        removedCharacters: 0,
        error: message,
      };
    }
  }
}
