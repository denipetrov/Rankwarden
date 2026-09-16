import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RunLogger, withRunId } from '../common/logging/run-context.js';
import { RaiderIoBudget } from '../common/quota/raiderio-budget.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import type { MplusAffixDocument } from '../mplus/entities/mplus-affix.entity.js';
import {
  MplusCharacterAccumulator,
  runRegionOf,
  toAffixDocument,
  toRunDocument,
} from '../mplus/mplus.mapper.js';
import { MplusRepository } from '../mplus/mplus.repository.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import { AGGREGATE_REGION, RUNS_PER_PAGE } from '../raiderio/raiderio.constants.js';
import type {
  MplusArchiveRunDocument,
  MplusSeasonArchiveMarker,
  MplusSeasonDocument,
} from './entities/mplus-archive.entity.js';
import { MplusCatalogueService, type CatalogueRefresh } from './mplus-catalogue.service.js';
import { pendingSeasons } from './mplus-archive.mapper.js';
import { MplusArchiveRepository } from './mplus-archive.repository.js';

/** What one season's archive attempt came to. */
export interface MplusSeasonArchiveResult {
  season: string;
  outcome: 'complete' | 'incomplete' | 'unarchivable' | 'adopted' | 'yielded';
  pagesPlanned: number;
  pagesFetched: number;
  failedPages: number[];
  runs: number;
  characters: number;
  skippedRuns: number;
  /** Why the season stopped short, when it did. */
  reason: string | null;
}

export interface MplusArchiveTickResult {
  catalogue: CatalogueRefresh;
  seasons: MplusSeasonArchiveResult[];
  /** Seasons still owed after this tick. */
  pending: number;
  /** Why the tick ended before the backlog did, if it did. */
  stoppedEarly: string | null;
}

/**
 * What the archive has done, for readiness to report without reading the
 * database — the same arrangement as `EnrichmentOutlook` and `MplusOutlook`.
 */
export interface MplusArchiveStatus {
  lastTickAt: string | null;
  lastTick: (Omit<MplusArchiveTickResult, 'seasons'> & { seasons: number }) | null;
}

/**
 * Archives finished Mythic+ seasons from Raider.io, once each.
 *
 * Reads the `world` leaderboard to a shallow depth (`MPLUS_ARCHIVE_PAGES`, 100
 * by default: 2,000 runs), because the archive is a record of the top of each
 * season rather than a copy of it. Runs and characters land in their own
 * collections, apart from the live ones, as the PvP archive does.
 *
 * "Once" is enforced by a marker on the season's catalogue document, never by
 * counting rows (see `MplusSeasonArchiveMarker`). A season whose marker was lost
 * is recovered from its rows only when they are unambiguous — exactly a full
 * read's worth — and fetched again otherwise, which at 100 requests is cheaper
 * than trusting a partial read forever.
 *
 * The lowest-priority work in the service. It yields to every other job,
 * including between batches inside a season, and a season interrupted that way
 * is left with no marker so it is simply picked up again.
 */
@Injectable()
export class MplusArchiveService {
  private readonly logger = new RunLogger(MplusArchiveService.name);
  private readonly pages: number;
  private readonly concurrency: number;
  private readonly pageBatch: number;
  private readonly budgetWaitMs: number;
  private running = false;
  private status: MplusArchiveStatus = { lastTickAt: null, lastTick: null };

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: MythicPlusApi,
    private readonly catalogue: MplusCatalogueService,
    private readonly repository: MplusArchiveRepository,
    private readonly affixes: MplusRepository,
    private readonly coordinator: IngestionCoordinator,
    private readonly budget: RaiderIoBudget,
  ) {
    this.pages = config.get('MPLUS_ARCHIVE_PAGES', { infer: true });
    this.concurrency = config.get('RAIDERIO_CONCURRENCY', { infer: true });
    this.pageBatch = config.get('RAIDERIO_PAGE_BATCH', { infer: true });
    this.budgetWaitMs = config.get('RAIDERIO_BUDGET_WAIT_MS', { infer: true });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get lastStatus(): MplusArchiveStatus {
    return this.status;
  }

  /**
   * One tick: refresh the catalogue if it is due, then work through the backlog
   * until it is done, a higher-priority job starts, or the budget will not free.
   *
   * Returns null when a tick is already running, rather than queueing one.
   */
  async archiveBacklog(): Promise<MplusArchiveTickResult | null> {
    if (this.running) return null;

    this.running = true;

    try {
      return await withRunId('mplus-archive', () =>
        this.coordinator.duringMplusArchive(() => this.runBacklog()),
      );
    } finally {
      this.running = false;
    }
  }

  private async runBacklog(): Promise<MplusArchiveTickResult> {
    const catalogue = await this.catalogue.refreshIfDue();
    const results: MplusSeasonArchiveResult[] = [];
    // Seasons that did not finish this tick. Without it an `incomplete` season
    // is handed straight back by `pendingSeasons` and retried in a loop until
    // the archive's share of every minute is spent on the one season that keeps
    // failing — the trap the PvP archive's `failedThisTick` exists for.
    const skip = new Set<string>();
    let stoppedEarly: string | null = null;

    for (;;) {
      if (this.coordinator.isAboveMplusArchiveActive) {
        stoppedEarly = 'a higher-priority job is running';
        break;
      }

      const [next] = pendingSeasons(await this.repository.allSeasons(), {
        now: new Date(),
        skip,
      });
      if (!next) break;

      const result = await this.archiveSeason(next);
      results.push(result);

      if (result.outcome === 'yielded') {
        stoppedEarly = result.reason;
        break;
      }

      if (result.outcome === 'incomplete') skip.add(next.slug);
    }

    const pending = pendingSeasons(await this.repository.allSeasons(), {
      now: new Date(),
    }).length;

    const tick: MplusArchiveTickResult = { catalogue, seasons: results, pending, stoppedEarly };
    this.status = {
      lastTickAt: new Date().toISOString(),
      lastTick: { ...tick, seasons: results.length },
    };

    if (results.length > 0 || stoppedEarly) {
      this.logger.log(
        `Mythic+ archive tick: ${results.length} season(s) attempted, ${pending} still pending` +
          (stoppedEarly ? `; stopped early: ${stoppedEarly}` : ''),
      );
    }

    return tick;
  }

  /** Archives one season, or recovers its lost marker from what is stored. */
  async archiveSeason(season: MplusSeasonDocument): Promise<MplusSeasonArchiveResult> {
    if (!season.archive && (await this.adoptStoredSeason(season))) {
      const stored = await this.repository.summariseStored(season.slug);

      return {
        season: season.slug,
        outcome: 'adopted',
        pagesPlanned: this.pages,
        pagesFetched: 0,
        failedPages: [],
        runs: stored.runs,
        characters: stored.characters,
        skippedRuns: 0,
        reason: null,
      };
    }

    return this.fetchSeason(season);
  }

  /**
   * Writes back a marker that was lost, when the stored rows prove the season
   * was read in full.
   *
   * Only exactly a full read's worth of runs counts as proof. Fewer is
   * ambiguous — a board that ended early and a fetch that died halfway both
   * store fewer — and a marker adopted on an ambiguous basis would make a
   * partial season permanent, since a `complete` season is never read again.
   * The fallback is a refetch, which at 100 requests costs less than the
   * question is worth.
   */
  private async adoptStoredSeason(season: MplusSeasonDocument): Promise<boolean> {
    const stored = await this.repository.summariseStored(season.slug);
    if (stored.runs !== this.pages * RUNS_PER_PAGE || stored.characters === 0) return false;

    await this.repository.recordArchive(season.slug, {
      status: 'complete',
      pagesPlanned: this.pages,
      pagesFetched: this.pages,
      failedPages: [],
      runs: stored.runs,
      characters: stored.characters,
      skippedRuns: 0,
      archivedAt: new Date(),
      source: 'adopted',
    });

    this.logger.log(
      `Adopted the stored Mythic+ archive of ${season.slug} (${stored.runs} runs) ` +
        'without refetching it',
    );

    return true;
  }

  private async fetchSeason(season: MplusSeasonDocument): Promise<MplusSeasonArchiveResult> {
    const archivedAt = new Date();
    const accumulator = new MplusCharacterAccumulator(season.slug, season.blizzardSeasonId, null);
    const result: MplusSeasonArchiveResult = {
      season: season.slug,
      outcome: 'complete',
      pagesPlanned: this.pages,
      pagesFetched: 0,
      failedPages: [],
      runs: 0,
      characters: 0,
      skippedRuns: 0,
      reason: null,
    };
    let exhausted = false;

    for (let first = 0; first < this.pages && !exhausted; first += this.pageBatch) {
      const pages = Array.from(
        { length: Math.min(this.pageBatch, this.pages - first) },
        (_unused, offset) => first + offset,
      );

      // Waits for room in the archive's share of the minute rather than giving
      // up, but abandons the wait the moment anything above it starts — that
      // is when the minute is most needed elsewhere.
      const room = await this.budget.waitForAllowance(
        'mplusArchive',
        pages.length,
        this.budgetWaitMs,
        () => this.coordinator.isAboveMplusArchiveActive,
      );

      if (this.coordinator.isAboveMplusArchiveActive) {
        return this.yielded(result, 'a higher-priority job started mid-season');
      }
      if (!room)
        return this.yielded(result, "the archive's share of the Raider.io budget is spent");

      let notFound: RaiderIoApiError | null = null;

      const fetched = await mapWithConcurrency(pages, this.concurrency, async (page) => {
        try {
          return { page, data: await this.api.getRunsPage(season.slug, AGGREGATE_REGION, page) };
        } catch (error) {
          if (error instanceof RaiderIoApiError && error.isBadRequest) return { page, data: null };
          if (error instanceof RaiderIoApiError && error.isNotFound) notFound = error;

          this.logger.warn(
            `Mythic+ archive page ${page} of ${season.slug} failed: ${describeError(error)}`,
          );

          return { page, data: undefined };
        }
      });

      // A 404 names the season, not the page: Raider.io will never serve it.
      // Recorded so one dead season cannot block the backlog behind it.
      if (notFound) return this.markUnarchivable(season, result, notFound);

      const runs: MplusArchiveRunDocument[] = [];
      const affixes = new Map<number, MplusAffixDocument>();

      for (const { page, data } of fetched) {
        // 400 past the last page the endpoint serves, or an empty page: the
        // board is shallower than the page limit. The end of the data, not a
        // failure.
        if (data === null) {
          exhausted = true;
          continue;
        }
        if (data === undefined) {
          result.failedPages.push(page);
          continue;
        }

        result.pagesFetched += 1;
        if (data.rankings.length === 0) exhausted = true;

        for (const ranking of data.rankings) {
          const region = runRegionOf(ranking);

          if (!region) {
            result.skippedRuns += 1;
            continue;
          }

          runs.push(toRunDocument(ranking, region, archivedAt));
          accumulator.add(ranking, archivedAt);

          for (const modifier of ranking.run.weekly_modifiers) {
            if (!affixes.has(modifier.id)) {
              affixes.set(modifier.id, toAffixDocument(modifier, archivedAt));
            }
          }
        }
      }

      // Affixes before the runs that reference them, as the live pass does. The
      // affix catalogue is shared with the live board: Legion's affixes simply
      // join it.
      await this.affixes.upsertAffixes([...affixes.values()]);
      await this.repository.upsertRuns(runs);
      result.runs += runs.length;
    }

    const characters = accumulator.drain();
    await this.repository.upsertCharacters(characters);
    result.characters = characters.length;

    if (result.failedPages.length > 0) {
      result.outcome = 'incomplete';
      result.reason = `${result.failedPages.length} page(s) failed`;
    }

    // After the rows, never before: a crash between the two leaves rows with no
    // marker, which the next tick recovers or refetches. The other order would
    // leave a `complete` marker over rows that were never written.
    await this.repository.recordArchive(season.slug, this.markerOf(result, archivedAt));

    this.logger.log(
      `Archived Mythic+ ${season.slug}: ${result.runs} runs and ${result.characters} ` +
        `characters over ${result.pagesFetched} page(s)` +
        (result.outcome === 'incomplete' ? `; incomplete, ${result.reason}` : ''),
    );

    return result;
  }

  /**
   * Stops a season partway without writing a marker.
   *
   * No marker is the point. What was written is idempotent and a later tick
   * reads the season again from the start — the character fold needs every page
   * in one pass — whereas an `incomplete` marker would claim a failure that did
   * not happen.
   */
  private yielded(result: MplusSeasonArchiveResult, reason: string): MplusSeasonArchiveResult {
    this.logger.log(`Pausing the Mythic+ archive of ${result.season}: ${reason}`);

    return { ...result, outcome: 'yielded', reason };
  }

  private async markUnarchivable(
    season: MplusSeasonDocument,
    result: MplusSeasonArchiveResult,
    error: RaiderIoApiError,
  ): Promise<MplusSeasonArchiveResult> {
    const reason = describeError(error);

    this.logger.warn(
      `Raider.io does not serve Mythic+ season ${season.slug} (${reason}); ` +
        'marking it unarchivable and moving on',
    );

    const marked = { ...result, outcome: 'unarchivable' as const, reason };
    await this.repository.recordArchive(season.slug, {
      ...this.markerOf(marked, new Date()),
      lastError: reason,
    });

    return marked;
  }

  private markerOf(result: MplusSeasonArchiveResult, archivedAt: Date): MplusSeasonArchiveMarker {
    return {
      status:
        result.outcome === 'unarchivable'
          ? 'unarchivable'
          : result.outcome === 'incomplete'
            ? 'incomplete'
            : 'complete',
      pagesPlanned: result.pagesPlanned,
      pagesFetched: result.pagesFetched,
      failedPages: result.failedPages,
      runs: result.runs,
      characters: result.characters,
      skippedRuns: result.skippedRuns,
      archivedAt,
      source: 'fetched',
    };
  }
}
