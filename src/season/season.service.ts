import { Injectable, Logger } from '@nestjs/common';

import { PvpApi } from '../blizzard/pvp.api.js';
import type { Region } from '../blizzard/blizzard.constants.js';

/**
 * In-memory record of the active PvP season per region. Resolved at startup and
 * refreshed before every sweep, since a new season invalidates every leaderboard.
 */
@Injectable()
export class SeasonService {
  private readonly logger = new Logger(SeasonService.name);
  private readonly currentSeasons = new Map<Region, number>();

  constructor(private readonly pvpApi: PvpApi) {}

  /** Fetches and caches the current season id for a region. */
  async refresh(region: Region): Promise<number> {
    const index = await this.pvpApi.getSeasonIndex(region);
    const seasonId = index.current_season.id;
    const previous = this.currentSeasons.get(region);

    if (previous !== seasonId) {
      this.logger.log(`Active season for ${region}: ${previous ?? 'none'} -> ${seasonId}`);
    }
    this.currentSeasons.set(region, seasonId);

    return seasonId;
  }

  /** Cached season id, or undefined if this region has not been refreshed yet. */
  getCurrentSeason(region: Region): number | undefined {
    return this.currentSeasons.get(region);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.currentSeasons);
  }
}
