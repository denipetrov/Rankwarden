import { Injectable, Logger } from '@nestjs/common';

import { PvpApi } from '../blizzard/pvp.api.js';
import type { Region } from '../blizzard/blizzard.constants.js';

interface CachedSeason {
  id: number;
  name?: string;
  startsAt: Date;
  /** Null while the season is still running. */
  endsAt: Date | null;
}

/**
 * In-memory record of the active PvP season per region. Resolved at startup and
 * refreshed before every sweep, since a new season invalidates every leaderboard.
 */
@Injectable()
export class SeasonService {
  private readonly logger = new Logger(SeasonService.name);
  private readonly currentSeasons = new Map<Region, CachedSeason>();
  private readonly lastCompleted = new Map<Region, number>();

  constructor(private readonly pvpApi: PvpApi) {}

  /** Fetches and caches the current season for a region. */
  async refresh(region: Region): Promise<number> {
    const index = await this.pvpApi.getSeasonIndex(region);
    const seasonId = index.current_season.id;
    const previous = this.currentSeasons.get(region);

    if (index.last_completed_season) {
      this.lastCompleted.set(region, index.last_completed_season.id);
    }

    // Blizzard writes `season_end_timestamp` onto the season's own record when
    // it ends, so the record stays worth re-reading for as long as no end date
    // has appeared. Once one has, nothing about it can change again.
    if (previous?.id === seasonId && previous.endsAt !== null) return seasonId;

    const season = await this.pvpApi.getSeason(region, seasonId);
    this.currentSeasons.set(region, {
      id: seasonId,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
    });

    if (!previous) {
      this.logger.log(
        `Active season for ${region}: ${seasonId} (started ${season.startsAt.toISOString()})`,
      );
    } else if (previous.id !== seasonId) {
      this.logger.warn(
        `Season rollover in ${region}: ${previous.id} replaced by ${seasonId} ` +
          `(started ${season.startsAt.toISOString()})`,
      );
    } else if (season.endsAt) {
      this.logger.warn(
        `Season ${seasonId} has ended in ${region} at ${season.endsAt.toISOString()}`,
      );
    }

    return seasonId;
  }

  /** Cached season id, or undefined if this region has not been refreshed yet. */
  getCurrentSeason(region: Region): number | undefined {
    return this.currentSeasons.get(region)?.id;
  }

  /** When the cached season began — the boundary for data worth keeping. */
  getSeasonStart(region: Region): Date | undefined {
    return this.currentSeasons.get(region)?.startsAt;
  }

  /** When the cached season ended, null if it is still running. */
  getSeasonEnd(region: Region): Date | null | undefined {
    return this.currentSeasons.get(region)?.endsAt;
  }

  /**
   * Whether the region's season has finished but no new one has started yet.
   * A region that has never been refreshed is not "ended" — it is unknown.
   */
  hasEnded(region: Region): boolean {
    const season = this.currentSeasons.get(region);

    return season !== undefined && season.endsAt !== null;
  }

  /** Everything known about each region's season, for the health endpoint. */
  describe(): Record<
    string,
    { id: number; name?: string; startsAt: string; endsAt: string | null; lastCompleted?: number }
  > {
    return Object.fromEntries(
      [...this.currentSeasons].map(([region, season]) => [
        region,
        {
          id: season.id,
          name: season.name,
          startsAt: season.startsAt.toISOString(),
          endsAt: season.endsAt?.toISOString() ?? null,
          lastCompleted: this.lastCompleted.get(region),
        },
      ]),
    );
  }
}
