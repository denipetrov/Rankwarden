import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isIngestableBracket, type Bracket, type Region } from '../blizzard/blizzard.constants.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { RateLimiter } from '../common/utils/rate-limiter.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { SeasonService } from '../season/season.service.js';
import { ArchiveRepository } from './archive.repository.js';
import type { ArchiveEntryDocument } from './entities/archive.entity.js';

export interface ArchiveSeasonResult {
  seasonId: number;
  region: Region;
  brackets: number;
  entries: number;
  failedBrackets: Bracket[];
}

/**
 * Stores finished seasons in their own collections.
 *
 * Historical standings never change, so a season is fetched once and marked
 * done. Only what the leaderboard endpoint itself returns is kept — no profile
 * enrichment — because that costs two extra requests per character for data
 * that describes the player today rather than during the season.
 */
@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name);
  private readonly regions: Region[];
  private readonly concurrency: number;
  private readonly minSeason: number;
  private readonly maxSeason: number;
  private readonly maxEntriesPerBracket: number;
  private readonly limiter: RateLimiter;

  constructor(
    config: ConfigService<Env, true>,
    private readonly pvpApi: PvpApi,
    private readonly seasons: SeasonService,
    private readonly repository: ArchiveRepository,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
    this.concurrency = config.get('ARCHIVE_CONCURRENCY', { infer: true });
    this.minSeason = config.get('ARCHIVE_MIN_SEASON', { infer: true });
    this.maxSeason = config.get('ARCHIVE_MAX_SEASON', { infer: true });
    this.maxEntriesPerBracket = config.get('ARCHIVE_MAX_ENTRIES_PER_BRACKET', { infer: true });
    this.limiter = new RateLimiter(config.get('ARCHIVE_REQUESTS_PER_SECOND', { infer: true }));
  }

  /**
   * The next season/region still to archive, or null when there is nothing left.
   *
   * A season qualifies once it is no longer the active one — either an older
   * season, or the current one after Blizzard has stamped it with an end date.
   */
  async nextPending(
    skip: ReadonlySet<string> = new Set(),
  ): Promise<{ seasonId: number; region: Region } | null> {
    const settled = await this.repository.settledSeasons();

    for (const region of this.regions) {
      const seasonIds = await this.archivableSeasons(region);

      for (const seasonId of seasonIds) {
        const key = `${seasonId}:${region}`;
        if (settled.has(key) || skip.has(key)) continue;

        // No marker, but the rows may still be there — a crash mid-season, or a
        // dropped markers collection. Re-fetching months-old standings that are
        // already stored is pure waste, so check the data before trusting the
        // absence of a marker.
        if (await this.adoptStoredSeason(seasonId, region)) continue;

        return { seasonId, region };
      }
    }

    return null;
  }

  /**
   * Recognises a season whose rows are already stored and writes back the marker
   * that was missing, so the next startup takes the cheap path.
   *
   * Adoption is only safe when the stored brackets match the ones the API
   * publishes. A process killed partway through leaves rows with no marker, and
   * adopting on the mere presence of rows would write a marker claiming nothing
   * outstanding — after which the missing brackets are never fetched and nothing
   * reports a problem. One request to compare against is far cheaper than the
   * ~83 a re-fetch costs, and cheaper still than losing the data silently.
   */
  private async adoptStoredSeason(seasonId: number, region: Region): Promise<boolean> {
    const stored = await this.repository.summariseStored(seasonId, region);
    if (stored.entries === 0) return false;

    const expected = await this.publishedBrackets(region, seasonId);
    const missing = expected.filter((bracket) => !stored.brackets.includes(bracket));
    const season = await this.seasonMetadata(region, seasonId);

    await this.repository.recordSeason({
      seasonId,
      region,
      name: season?.name,
      startsAt: season?.startsAt ?? null,
      endsAt: season?.endsAt ?? null,
      brackets: stored.brackets.length,
      entries: stored.entries,
      failedBrackets: missing,
      archivedAt: new Date(),
    });

    if (missing.length > 0) {
      this.logger.warn(
        `Season ${seasonId} ${region} is only partly stored (${stored.brackets.length}/` +
          `${expected.length} brackets); ${missing.length} outstanding and will be fetched`,
      );

      return false;
    }

    this.logger.log(
      `Season ${seasonId} ${region} is already stored (${stored.entries} entries across ` +
        `${stored.brackets.length} brackets); skipping the fetch`,
    );

    return true;
  }

  /**
   * The ingestable brackets the API publishes for a season, or an empty list if
   * it will not say. An empty list makes the comparison above vacuous, which is
   * the right outcome: a season Blizzard no longer describes cannot be
   * completed, so whatever is stored is all there will ever be.
   */
  private async publishedBrackets(region: Region, seasonId: number): Promise<Bracket[]> {
    try {
      await this.limiter.acquire();

      return (await this.pvpApi.getBrackets(region, seasonId)).filter(isIngestableBracket);
    } catch (error) {
      this.logger.warn(
        `No bracket list for ${seasonId} ${region}: ${describeError(error)}; ` +
          'treating what is stored as complete',
      );

      return [];
    }
  }

  /** Records a season the API will never serve, so the backlog moves past it. */
  async markUnarchivable(seasonId: number, region: Region, reason: string): Promise<void> {
    await this.repository.markUnarchivable(seasonId, region, reason);
  }

  /** Season ids that are finished, newest first so recent history lands soonest. */
  private async archivableSeasons(region: Region): Promise<number[]> {
    const index = await this.pvpApi.getSeasonIndex(region);
    const current = index.current_season.id;
    // The active season is archived only once it has actually ended.
    const currentHasEnded = this.seasons.hasEnded(region);

    return index.seasons
      .map((season) => season.id)
      .filter((id) => id >= this.minSeason)
      .filter((id) => this.maxSeason === 0 || id <= this.maxSeason)
      .filter((id) => id < current || (id === current && currentHasEnded))
      .sort((a, b) => b - a);
  }

  /**
   * Fetches and stores one season for one region.
   *
   * Only the brackets not already stored are fetched. A season with two failed
   * brackets out of 83 used to cost 83 requests per retry, per region, every
   * attempt — and when the failures came from live ingestion pre-empting the
   * archive, that pattern repeated for as long as the sweeps kept landing.
   */
  async archiveSeason(seasonId: number, region: Region): Promise<ArchiveSeasonResult> {
    const startedAt = Date.now();
    await this.limiter.acquire();
    const brackets = (await this.pvpApi.getBrackets(region, seasonId)).filter(isIngestableBracket);
    const stored = new Set((await this.repository.summariseStored(seasonId, region)).brackets);
    const outstanding = brackets.filter((bracket) => !stored.has(bracket));

    if (stored.size > 0) {
      this.logger.log(
        `Resuming season ${seasonId} ${region}: ${outstanding.length} of ${brackets.length} ` +
          'brackets outstanding',
      );
    }

    const results = await mapWithConcurrency(outstanding, this.concurrency, (bracket) =>
      this.archiveBracket(seasonId, region, bracket),
    );

    const failedBrackets = results
      .filter((result) => result.failed)
      .map((result) => result.bracket);
    const entries = results.reduce((total, result) => total + result.entries, 0);
    const season = await this.seasonMetadata(region, seasonId);

    await this.repository.recordSeason({
      seasonId,
      region,
      name: season?.name,
      startsAt: season?.startsAt ?? null,
      endsAt: season?.endsAt ?? null,
      brackets: brackets.length,
      entries: await this.repository.countEntries(seasonId, region),
      failedBrackets,
      archivedAt: new Date(),
    });

    this.logger.log(
      `Archived season ${seasonId} ${region}: ${brackets.length - failedBrackets.length}/` +
        `${brackets.length} brackets, ${entries} entries, ${Date.now() - startedAt}ms` +
        (failedBrackets.length > 0 ? ` (${failedBrackets.length} failed, will retry)` : ''),
    );

    return { seasonId, region, brackets: brackets.length, entries, failedBrackets };
  }

  private async seasonMetadata(region: Region, seasonId: number) {
    try {
      await this.limiter.acquire();
      return await this.pvpApi.getSeason(region, seasonId);
    } catch (error) {
      this.logger.warn(`No season record for ${seasonId} ${region}: ${describeError(error)}`);
      return null;
    }
  }

  private async archiveBracket(
    seasonId: number,
    region: Region,
    bracket: Bracket,
  ): Promise<{ bracket: Bracket; entries: number; failed: boolean }> {
    // Live data outranks history that has already waited months. Leaving the
    // bracket unfinished keeps the season pending, so it resumes later.
    if (this.coordinator.isLiveIngestionActive) {
      return { bracket, entries: 0, failed: true };
    }

    try {
      await this.limiter.acquire();
      const leaderboard = await this.pvpApi.getLeaderboard(region, seasonId, bracket);

      // Sorted rather than trusting rank order, then capped: the archive keeps
      // the top of each ladder, which is the part anyone looks back at.
      const ranked = [...leaderboard.entries]
        .sort((left, right) => right.rating - left.rating)
        .slice(0, this.maxEntriesPerBracket);

      const documents: ArchiveEntryDocument[] = ranked.map((entry) => ({
        seasonId,
        region,
        bracket,
        characterId: entry.character.id,
        characterName: entry.character.name,
        realmId: entry.character.realm.id,
        realmSlug: entry.character.realm.slug,
        faction: entry.faction?.type ?? null,
        rank: entry.rank,
        rating: entry.rating,
        played: entry.season_match_statistics?.played ?? 0,
        won: entry.season_match_statistics?.won ?? 0,
        lost: entry.season_match_statistics?.lost ?? 0,
      }));

      await this.repository.insertEntries(documents);

      return { bracket, entries: documents.length, failed: false };
    } catch (error) {
      this.logger.warn(
        `Could not archive ${seasonId} ${region}/${bracket}: ${describeError(error)}`,
      );

      return { bracket, entries: 0, failed: true };
    }
  }
}
