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
  toAffixDocument,
  toRunDocument,
} from '../mplus/mplus.mapper.js';
import { MplusRepository } from '../mplus/mplus.repository.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import { RUNS_PER_PAGE, type RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type {
  MplusRegionArchive,
  MplusSeasonArchiveMarker,
  MplusSeasonDocument,
} from '../mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueRepository } from '../mplus-season/mplus-catalogue.repository.js';
import {
  MplusCatalogueService,
  type CatalogueRefresh,
} from '../mplus-season/mplus-catalogue.service.js';
import type { MplusArchiveRunDocument } from './entities/mplus-archive.entity.js';
import { pendingSeasons, regionsOwed } from './mplus-archive.mapper.js';
import { MplusArchiveRepository } from './mplus-archive.repository.js';

/** What one season's archive attempt came to. */
export interface MplusSeasonArchiveResult {
  season: string;
  /**
   * `adopted` when every region owed was recovered from stored rows with no
   * request; `yielded` when a higher-priority job interrupted it. Otherwise the
   * season's marker status after the attempt.
   */
  outcome: 'complete' | 'incomplete' | 'unarchivable' | 'adopted' | 'yielded';
  /** Regions this attempt read or adopted, in order. */
  regions: RaiderIoRegion[];
  /** Pages planned across those regions. */
  pagesPlanned: number;
  pagesFetched: number;
  /** Failed pages as `region:page`. */
  failedPages: string[];
  runs: number;
  characters: number;
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

/** How reading one region's board ended. */
type RegionOutcome =
  | { kind: 'read'; entry: MplusRegionArchive }
  | { kind: 'yielded'; reason: string }
  | { kind: 'unarchivable'; error: RaiderIoApiError };

/**
 * Archives finished Mythic+ seasons from Raider.io, once each.
 *
 * Reads **each configured region's own board** (`RAIDERIO_REGIONS`), exactly
 * as the live pass does, to `MPLUS_ARCHIVE_PAGES` pages a region — 100 by
 * default, 2,000 runs. Per region rather than the `world` board because a
 * region's board is what a region's ranks, scores and title cutoffs are read
 * against: the world top 2,000 is mostly one region (1,212 of `season-tww-3`'s
 * were `cn`) and holds only the very top of the rest. Characters are folded
 * per region too, as the live pass folds them.
 *
 * Runs and characters land in their own collections, apart from the live ones,
 * as the PvP archive does.
 *
 * "Once" is enforced by a marker on the season's catalogue document, with a
 * record per region, never by counting rows (see `MplusSeasonArchiveMarker`).
 * Each region is settled on its own, so a retry re-reads only the regions that
 * are not complete. A region whose marker was lost is recovered from its rows
 * only when they are unambiguous — exactly a full read's worth — and fetched
 * again otherwise, which at 100 requests is cheaper than trusting a partial read
 * forever.
 *
 * The lowest-priority work in the service. It yields to every other job,
 * including between batches inside a region. The region interrupted is read
 * again from its first page; regions already read are kept.
 */
@Injectable()
export class MplusArchiveService {
  private readonly logger = new RunLogger(MplusArchiveService.name);
  private readonly regions: RaiderIoRegion[];
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
    private readonly seasons: MplusCatalogueRepository,
    private readonly repository: MplusArchiveRepository,
    private readonly affixes: MplusRepository,
    private readonly coordinator: IngestionCoordinator,
    private readonly budget: RaiderIoBudget,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
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

      const [next] = pendingSeasons(await this.seasons.allSeasons(), {
        now: new Date(),
        regions: this.regions,
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

    const pending = pendingSeasons(await this.seasons.allSeasons(), {
      now: new Date(),
      regions: this.regions,
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

  /**
   * Archives the regions a season still owes, one board at a time.
   *
   * Regions already `complete` are kept as they are. A marker written by the
   * earlier `world` reader has no regions, so every region is owed and read;
   * its rows are overwritten rather than deleted first, because every run in
   * the world top 2,000 is also in its own region's top 2,000.
   */
  async archiveSeason(season: MplusSeasonDocument): Promise<MplusSeasonArchiveResult> {
    const held: Partial<Record<RaiderIoRegion, MplusRegionArchive>> = {
      ...(season.archive?.regions ?? {}),
    };
    const result: MplusSeasonArchiveResult = {
      season: season.slug,
      outcome: 'complete',
      regions: [],
      pagesPlanned: 0,
      pagesFetched: 0,
      failedPages: [],
      runs: 0,
      characters: 0,
      reason: null,
    };
    let fetched = false;
    let progressed = false;

    for (const region of regionsOwed(season, this.regions)) {
      result.regions.push(region);
      result.pagesPlanned += this.pages;

      // Adoption only with no marker at all. A marker that exists is an
      // explicit record of what was read, and its absence for a region means
      // that region was never finished — not that its rows need interpreting.
      const adopted = season.archive ? null : await this.adoptStoredRegion(season, region);
      if (adopted) {
        held[region] = adopted;
        progressed = true;
        result.runs += adopted.runs;
        result.characters += adopted.characters;
        continue;
      }

      const outcome = await this.fetchRegion(season, region);

      if (outcome.kind === 'unarchivable')
        return this.markUnarchivable(season, result, outcome.error);

      if (outcome.kind === 'yielded') {
        this.logger.log(
          `Pausing the Mythic+ archive of ${season.slug} in ${region}: ${outcome.reason}`,
        );
        // Regions read before the interruption are kept; the one interrupted is
        // read again from its first page, since its fold needs every page.
        if (progressed) {
          await this.seasons.recordArchive(season.slug, this.markerOf(held, 'partial'));
        }

        return { ...result, outcome: 'yielded', reason: outcome.reason };
      }

      fetched = true;
      progressed = true;
      held[region] = outcome.entry;
      result.pagesFetched += outcome.entry.pagesFetched;
      result.failedPages.push(...outcome.entry.failedPages.map((page) => `${region}:${page}`));
      result.runs += outcome.entry.runs;
      result.characters += outcome.entry.characters;
    }

    const marker = this.markerOf(held);
    // After the rows, never before: a crash between the two leaves rows with no
    // marker, which the next tick recovers or refetches. The other order would
    // leave a `complete` marker over rows that were never written.
    await this.seasons.recordArchive(season.slug, marker);

    result.outcome =
      marker.status === 'incomplete' ? 'incomplete' : fetched ? 'complete' : 'adopted';
    if (result.outcome === 'incomplete') {
      result.reason = `${result.failedPages.length} page(s) failed`;
    }

    this.logger.log(
      `Archived Mythic+ ${season.slug} in ${result.regions.join(', ')}: ${result.runs} runs and ` +
        `${result.characters} characters over ${result.pagesFetched} page(s)` +
        (result.outcome === 'incomplete' ? `; incomplete, ${result.reason}` : '') +
        (result.outcome === 'adopted' ? ', recovered from stored rows' : ''),
    );

    return result;
  }

  /**
   * Recovers a region whose marker was lost, when its stored rows prove it was
   * read in full.
   *
   * Only exactly a full read's worth of runs counts as proof. Fewer is
   * ambiguous — a board that ended early and a fetch that died halfway both
   * store fewer — and adopting on an ambiguous basis would make a partial
   * region permanent, since a `complete` region is never read again. The
   * fallback is a refetch, which at 100 requests costs less than the question
   * is worth.
   */
  private async adoptStoredRegion(
    season: MplusSeasonDocument,
    region: RaiderIoRegion,
  ): Promise<MplusRegionArchive | null> {
    const stored = await this.repository.summariseStored(season.slug, region);
    if (stored.runs !== this.pages * RUNS_PER_PAGE || stored.characters === 0) return null;

    this.logger.log(
      `Adopted the stored Mythic+ archive of ${season.slug} in ${region} (${stored.runs} runs) ` +
        'without refetching it',
    );

    return {
      status: 'complete',
      pagesFetched: this.pages,
      failedPages: [],
      runs: stored.runs,
      characters: stored.characters,
      archivedAt: new Date(),
      source: 'adopted',
    };
  }

  /** Reads one region's board for a season, writing runs per batch and characters at the end. */
  private async fetchRegion(
    season: MplusSeasonDocument,
    region: RaiderIoRegion,
  ): Promise<RegionOutcome> {
    const archivedAt = new Date();
    const accumulator = new MplusCharacterAccumulator(season.slug, season.blizzardSeasonId, region);
    const entry: MplusRegionArchive = {
      status: 'complete',
      pagesFetched: 0,
      failedPages: [],
      runs: 0,
      characters: 0,
      archivedAt,
      source: 'fetched',
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
        return { kind: 'yielded', reason: 'a higher-priority job started mid-season' };
      }
      if (!room) {
        return { kind: 'yielded', reason: "the archive's share of the Raider.io budget is spent" };
      }

      let notFound: RaiderIoApiError | null = null;

      const fetched = await mapWithConcurrency(pages, this.concurrency, async (page) => {
        try {
          return { page, data: await this.api.getRunsPage(season.slug, region, page) };
        } catch (error) {
          if (error instanceof RaiderIoApiError && error.isBadRequest) return { page, data: null };
          if (error instanceof RaiderIoApiError && error.isNotFound) notFound = error;

          this.logger.warn(
            `Mythic+ archive page ${page} of ${season.slug} in ${region} failed: ` +
              describeError(error),
          );

          return { page, data: undefined };
        }
      });

      // A 404 names the season, not the page: Raider.io will never serve it.
      // A region with no board for the season answers 200 with no rankings
      // instead, so this never mistakes a quiet region for a dead season.
      if (notFound) return { kind: 'unarchivable', error: notFound };

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
          entry.failedPages.push(page);
          continue;
        }

        entry.pagesFetched += 1;
        if (data.rankings.length === 0) exhausted = true;

        for (const ranking of data.rankings) {
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
      // affix catalogue is shared with the live board: an old season's affixes
      // simply join it.
      await this.affixes.upsertAffixes([...affixes.values()]);
      await this.repository.upsertRuns(runs);
      entry.runs += runs.length;
    }

    const characters = accumulator.drain();
    await this.repository.upsertCharacters(characters);
    entry.characters = characters.length;

    if (entry.failedPages.length > 0) entry.status = 'incomplete';

    return { kind: 'read', entry };
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

    await this.seasons.recordArchive(season.slug, {
      ...this.markerOf({}, 'unarchivable'),
      lastError: reason,
    });

    return { ...result, outcome: 'unarchivable', reason };
  }

  /**
   * The season marker for the regions held. Totals are sums over the regions;
   * the status is judged over the configured regions only, so a region dropped
   * from `RAIDERIO_REGIONS` does not hold a season open forever.
   */
  private markerOf(
    regions: Partial<Record<RaiderIoRegion, MplusRegionArchive>>,
    override?: 'partial' | 'unarchivable',
  ): MplusSeasonArchiveMarker {
    const entries = Object.entries(regions) as [RaiderIoRegion, MplusRegionArchive][];
    const configured = this.regions.map((region) => regions[region]);
    const status =
      override ??
      (configured.some((entry) => entry?.status === 'incomplete')
        ? 'incomplete'
        : configured.every((entry) => entry?.status === 'complete')
          ? 'complete'
          : 'partial');

    return {
      status,
      pagesPlanned: this.pages,
      pagesFetched: entries.reduce((sum, [, entry]) => sum + entry.pagesFetched, 0),
      failedPages: entries.flatMap(([region, entry]) =>
        entry.failedPages.map((page) => `${region}:${page}`),
      ),
      runs: entries.reduce((sum, [, entry]) => sum + entry.runs, 0),
      characters: entries.reduce((sum, [, entry]) => sum + entry.characters, 0),
      regions,
      archivedAt: new Date(),
      source:
        entries.length > 0 && entries.every(([, entry]) => entry.source === 'adopted')
          ? 'adopted'
          : 'fetched',
    };
  }
}
