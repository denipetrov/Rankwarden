import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RunLogger, withRunId } from '../common/logging/run-context.js';
import { RaiderIoBudget, type MplusOutlook } from '../common/quota/raiderio-budget.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { describeError, errorStack } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import { MAX_RUNS_PAGE, type RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import type { MplusAffixDocument } from './entities/mplus-affix.entity.js';
import type { MplusRunDocument } from './entities/mplus-run.entity.js';
import { MplusSeasonService, openRegions } from './mplus-season.service.js';
import { MplusCharacterAccumulator, toAffixDocument, toRunDocument } from './mplus.mapper.js';
import { MplusRepository } from './mplus.repository.js';

/** What one region's pass achieved. */
export interface MplusRegionResult {
  region: RaiderIoRegion;
  pagesPlanned: number;
  pagesFetched: number;
  pagesFailed: number;
  runs: number;
  characters: number;
  /**
   * Characters whose stored score survived a lower freshly computed one,
   * because a dungeon's best run has dropped out of the ingested window.
   *
   * Worth reporting rather than silently correct: a number that climbs pass
   * after pass says the leaderboard window is outrunning the ladder, and the
   * fix is more pages, not more merging.
   */
  mergedCharacters: number;
  prunedRuns: number;
  prunedCharacters: number;
  /** Null when the region finished cleanly; otherwise why it stopped early. */
  stoppedEarly: string | null;
}

export interface MplusSweepResult {
  season: string;
  startedAt: string;
  durationMs: number;
  regions: MplusRegionResult[];
  runs: number;
  characters: number;
  requests: number;
  stoppedEarly: string | null;
}

/**
 * Ingests the top Mythic+ runs for the current season, one region at a time.
 *
 * A pass is `MAX_RUNS_PAGE + 1` pages per region — 1,001 requests, up to 20,020
 * runs — fetched with bounded concurrency and written as it goes rather than
 * accumulated whole: a region is ~100,000 roster rows, and holding all of them
 * before the first write would make memory scale with the ladder rather than
 * with the batch.
 *
 * What is *not* streamed is the character fold. `mythicScore` is a character's
 * best run in each dungeon summed across the whole region, so it cannot be
 * written until the last page of that region has been read. The fold keeps only
 * about eight entries per distinct character, so its working set is bounded by
 * characters rather than by rows (see `MplusCharacterAccumulator`).
 */
@Injectable()
export class MplusService {
  private readonly logger = new RunLogger(MplusService.name);
  private readonly regions: RaiderIoRegion[];
  private readonly concurrency: number;
  private readonly pageBatch: number;
  private readonly maxPages: number;
  private readonly intervalMs: number;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: MythicPlusApi,
    private readonly seasons: MplusSeasonService,
    private readonly repository: MplusRepository,
    private readonly coordinator: IngestionCoordinator,
    private readonly budget: RaiderIoBudget,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
    this.concurrency = config.get('RAIDERIO_CONCURRENCY', { infer: true });
    this.pageBatch = config.get('RAIDERIO_PAGE_BATCH', { infer: true });
    this.maxPages = config.get('RAIDERIO_MAX_PAGES', { infer: true });
    this.intervalMs = config.get('MPLUS_INTERVAL_MS', { infer: true });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * One full pass over every configured region.
   *
   * Returns null rather than queueing when a pass is already in flight, the way
   * `LeaderboardService.sweep` does: two passes over the same leaderboard would
   * race each other's writes for no gain.
   *
   * The run id is established here rather than in the scheduler, following
   * `LeaderboardService.sweep` and `ProfileEnrichmentService.run`. It is what
   * attributes every Raider.io request below to the M+ consumer, so a pass
   * driven from anywhere — the scheduler, the admin trigger, a test — is
   * charged to the budget the same way. Established in the scheduler instead,
   * a direct call would spend against the catch-all bucket and the job's own
   * spend would read as zero.
   */
  async sweep(): Promise<MplusSweepResult | null> {
    if (this.running) return null;

    this.running = true;
    const startedAt = new Date();

    try {
      return await withRunId('mplus', () => {
        const requestsBefore = this.budget.spent('mplus');

        return this.coordinator.duringMplus(() => this.runSweep(startedAt, requestsBefore));
      });
    } finally {
      this.running = false;
    }
  }

  private async runSweep(startedAt: Date, requestsBefore: number): Promise<MplusSweepResult> {
    const season = await this.seasons.current();
    const regions = openRegions(season, this.regions, startedAt);
    const skipped = this.regions.filter((region) => !regions.includes(region));

    if (skipped.length > 0) {
      this.logger.log(
        `Season ${season.slug} has not started in ${skipped.join(', ')}; skipping ${skipped.length} region(s)`,
      );
    }

    const results: MplusRegionResult[] = [];
    let stoppedEarly: string | null = null;

    for (const region of regions) {
      // Re-checked between regions rather than only at the start: the M+ pass
      // is minutes long, so a sweep or enrichment pass beginning in the middle
      // of it would otherwise be competing for Mongo until it finished. The
      // request budgets are independent — this is purely about the database and
      // the process.
      if (this.coordinator.isLiveIngestionActive) {
        stoppedEarly = 'live PvP ingestion started';
        this.logger.log('Live PvP ingestion in progress; pausing the Mythic+ pass');
        break;
      }

      const result = await this.sweepRegion(season.slug, season.seasonId, region);
      results.push(result);

      if (result.stoppedEarly && !stoppedEarly) stoppedEarly = result.stoppedEarly;
    }

    await this.purgeSupersededSeasons(season.slug);

    const durationMs = Date.now() - startedAt.getTime();
    const requests = this.budget.spent('mplus') - requestsBefore;
    const summary: MplusSweepResult = {
      season: season.slug,
      startedAt: startedAt.toISOString(),
      durationMs,
      regions: results,
      runs: results.reduce((sum, result) => sum + result.runs, 0),
      characters: results.reduce((sum, result) => sum + result.characters, 0),
      requests: Math.max(0, requests),
      stoppedEarly,
    };

    this.budget.publishMplusOutlook(this.outlookOf(summary));
    this.logger.log(
      `Mythic+ pass for ${season.slug} finished in ${Math.round(durationMs / 1000)}s: ` +
        `${summary.runs} runs, ${summary.characters} characters across ${results.length} region(s)`,
    );

    return summary;
  }

  /**
   * One region: pages in batches, writing each batch, folding characters across
   * the whole region, then pruning what fell off the board.
   */
  private async sweepRegion(
    season: string,
    seasonId: number | null,
    region: RaiderIoRegion,
  ): Promise<MplusRegionResult> {
    const fetchedAt = new Date();
    const accumulator = new MplusCharacterAccumulator(season, seasonId, region);
    const lastPage = Math.min(this.maxPages - 1, MAX_RUNS_PAGE);
    const result: MplusRegionResult = {
      region,
      pagesPlanned: lastPage + 1,
      pagesFetched: 0,
      pagesFailed: 0,
      runs: 0,
      characters: 0,
      mergedCharacters: 0,
      prunedRuns: 0,
      prunedCharacters: 0,
      stoppedEarly: null,
    };
    let exhausted = false;

    for (let first = 0; first <= lastPage && !exhausted; first += this.pageBatch) {
      // The budget is a per-minute ceiling, so this is checked per batch rather
      // than per pass: a pass runs for minutes and the window rolls underneath
      // it. The limiter paces within the minute; this is what stops the pass
      // from planning a batch the minute cannot pay for.
      if (this.budget.allowance() <= 0) {
        result.stoppedEarly = 'Raider.io budget spent';
        this.logger.warn(
          `Raider.io budget for the current minute is spent; stopping ${region} at page ${first}`,
        );
        break;
      }

      if (this.coordinator.isLiveIngestionActive) {
        result.stoppedEarly = 'live PvP ingestion started';
        break;
      }

      const pages = Array.from(
        { length: Math.min(this.pageBatch, lastPage - first + 1) },
        (_unused, offset) => first + offset,
      );

      const fetched = await mapWithConcurrency(pages, this.concurrency, async (page) => {
        try {
          return await this.api.getRunsPage(season, region, page);
        } catch (error) {
          // A 400 means the page is past the end of what the endpoint will
          // serve. It is the documented end of the data, not a failure, so it
          // stops the region rather than counting against it.
          if (error instanceof RaiderIoApiError && error.isBadRequest) return null;

          result.pagesFailed += 1;
          this.logger.warn(`Mythic+ page ${page} for ${region} failed: ${describeError(error)}`);

          return undefined;
        }
      });

      const runs: MplusRunDocument[] = [];
      const affixes = new Map<number, MplusAffixDocument>();

      for (const page of fetched) {
        if (page === null) {
          exhausted = true;
          continue;
        }
        if (page === undefined) continue;

        result.pagesFetched += 1;
        // An empty page is the other way the data ends: the endpoint answers
        // 200 with `rankings: []` rather than 400 for a region with fewer runs
        // than the page cap.
        if (page.rankings.length === 0) exhausted = true;

        for (const ranking of page.rankings) {
          runs.push(toRunDocument(ranking, region, fetchedAt));
          accumulator.add(ranking, fetchedAt);

          for (const modifier of ranking.run.weekly_modifiers) {
            if (!affixes.has(modifier.id)) {
              affixes.set(modifier.id, toAffixDocument(modifier, fetchedAt));
            }
          }
        }
      }

      // Affixes before the runs that reference them, so a reader following an
      // id from a run always finds it.
      await this.repository.upsertAffixes([...affixes.values()]);
      await this.repository.upsertRuns(runs);
      result.runs += runs.length;
    }

    const characters = accumulator.drain();
    const { merged } = await this.repository.upsertCharacters(characters);
    result.characters = characters.length;
    result.mergedCharacters = merged;

    // Pruning only after a clean pass. A pass that stopped early — a spent
    // budget, a yielded coordinator, a run of failed pages — looks exactly like
    // a leaderboard that lost most of its runs, and pruning on that basis would
    // delete the region and refill it next pass, hourly, with a hole in the
    // board each time.
    if (!result.stoppedEarly && result.pagesFailed === 0 && result.pagesFetched > 0) {
      const pruned = await this.repository.pruneStale(season, region, fetchedAt);
      result.prunedRuns = pruned.runs;
      result.prunedCharacters = pruned.characters;
    } else if (result.pagesFailed > 0) {
      this.logger.warn(
        `${result.pagesFailed} page(s) failed for ${region}; skipping the prune so a partial ` +
          'pass cannot empty the board',
      );
    }

    this.logger.log(
      `Mythic+ ${region}: ${result.runs} runs over ${result.pagesFetched} page(s), ` +
        `${result.characters} characters` +
        (result.mergedCharacters > 0
          ? `, ${result.mergedCharacters} kept a dungeon that left the window`
          : '') +
        (result.prunedRuns || result.prunedCharacters
          ? `, pruned ${result.prunedRuns} run(s) and ${result.prunedCharacters} character(s)`
          : ''),
    );

    return result;
  }

  /**
   * Drops seasons the service is no longer ingesting.
   *
   * Unlike the PvP archive there is nothing to preserve: M+ data here is a
   * snapshot of a live leaderboard, rebuilt in full on every pass, and a season
   * that has rolled over would otherwise sit in the collections forever, frozen,
   * indistinguishable from the current one to anything that forgets to filter.
   */
  private async purgeSupersededSeasons(current: string): Promise<void> {
    try {
      const stored = await this.repository.storedSeasons();
      const superseded = stored.filter((season) => season !== current);

      for (const season of superseded) {
        const removed = await this.repository.purgeSeason(season);
        this.logger.warn(
          `Retired Mythic+ season ${season}: removed ${removed.runs} run(s) and ` +
            `${removed.characters} character(s)`,
        );
      }
    } catch (error) {
      // Never fails the pass: the data just ingested is correct either way, and
      // the next pass tries again.
      this.logger.error(
        `Could not retire superseded Mythic+ seasons: ${describeError(error)}`,
        errorStack(error),
      );
    }
  }

  /** The verdict readiness reports, computed from the pass that just ran. */
  private outlookOf(summary: MplusSweepResult): MplusOutlook {
    const pagesPlanned = summary.regions.reduce((sum, result) => sum + result.pagesPlanned, 0);
    const capacityPerMinute = this.budget.usable;
    // Whether a full pass fits inside its own interval at the permitted rate.
    // If it does not, the cadence is a fiction: each pass would still be
    // running when the next was due.
    const minutesNeeded = capacityPerMinute > 0 ? pagesPlanned / capacityPerMinute : Infinity;

    return {
      computedAt: new Date().toISOString(),
      regions: summary.regions.length,
      regionsComplete: summary.regions.filter((result) => !result.stoppedEarly).length,
      pagesPlanned,
      pagesFetched: summary.regions.reduce((sum, result) => sum + result.pagesFetched, 0),
      pagesFailed: summary.regions.reduce((sum, result) => sum + result.pagesFailed, 0),
      runs: summary.runs,
      characters: summary.characters,
      durationMs: summary.durationMs,
      requests: summary.requests,
      capacityPerMinute,
      feasible: minutesNeeded * 60_000 <= this.intervalMs,
      stoppedEarly: summary.stoppedEarly,
    };
  }
}
