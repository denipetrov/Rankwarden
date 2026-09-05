import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  isIngestableBracket,
  isRegion,
  type Bracket,
  type Region,
} from '../blizzard/blizzard.constants.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { mapWithConcurrency } from '../common/utils/concurrency.js';
import { RateLimiter } from '../common/utils/rate-limiter.js';
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
    this.regions = config
      .get('BLIZZARD_REGIONS', { infer: true })
      .filter((region): region is Region => isRegion(region));
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
  async nextPending(): Promise<{ seasonId: number; region: Region } | null> {
    const completed = await this.repository.completedSeasons();

    for (const region of this.regions) {
      const seasonIds = await this.archivableSeasons(region);

      for (const seasonId of seasonIds) {
        if (completed.has(`${seasonId}:${region}`)) continue;

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
   */
  private async adoptStoredSeason(seasonId: number, region: Region): Promise<boolean> {
    if (!(await this.repository.hasStoredEntries(seasonId, region))) return false;

    const stored = await this.repository.summariseStored(seasonId, region);
    const season = await this.seasonMetadata(region, seasonId);

    await this.repository.recordSeason({
      seasonId,
      region,
      name: season?.name,
      startsAt: season?.startsAt ?? null,
      endsAt: season?.endsAt ?? null,
      brackets: stored.brackets,
      entries: stored.entries,
      failedBrackets: [],
      archivedAt: new Date(),
    });

    this.logger.log(
      `Season ${seasonId} ${region} is already stored (${stored.entries} entries across ` +
        `${stored.brackets} brackets); skipping the fetch`,
    );

    return true;
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

  /** Fetches and stores one season for one region. */
  async archiveSeason(seasonId: number, region: Region): Promise<ArchiveSeasonResult> {
    const startedAt = Date.now();
    await this.limiter.acquire();
    const brackets = (await this.pvpApi.getBrackets(region, seasonId)).filter(isIngestableBracket);

    const results = await mapWithConcurrency(brackets, this.concurrency, (bracket) =>
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`No season record for ${seasonId} ${region}: ${message}`);
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not archive ${seasonId} ${region}/${bracket}: ${message}`);

      return { bracket, entries: 0, failed: true };
    }
  }
}
