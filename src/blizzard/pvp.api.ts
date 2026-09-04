import { Injectable, Logger } from '@nestjs/common';

import type { Bracket, Region } from './blizzard.constants.js';
import { BlizzardHttpService } from './http/blizzard-http.service.js';
import { pvpSeasonIndexSchema, type PvpSeasonIndex } from './schemas/pvp-season.schema.js';
import { pvpLeaderboardSchema, type PvpLeaderboard } from './schemas/pvp-leaderboard.schema.js';
import { pvpLeaderboardIndexSchema } from './schemas/pvp-leaderboard-index.schema.js';

/** Typed access to the PvP slice of the Game Data API. */
@Injectable()
export class PvpApi {
  private readonly logger = new Logger(PvpApi.name);

  constructor(private readonly http: BlizzardHttpService) {}

  async getSeasonIndex(region: Region): Promise<PvpSeasonIndex> {
    const payload = await this.http.get(region, 'data/wow/pvp-season/index');
    return pvpSeasonIndexSchema.parse(payload);
  }

  /** Every bracket Blizzard publishes for a season, in the order it lists them. */
  async getBrackets(region: Region, seasonId: number): Promise<string[]> {
    const payload = await this.http.get(
      region,
      `data/wow/pvp-season/${seasonId}/pvp-leaderboard/index`,
    );
    const { leaderboards } = pvpLeaderboardIndexSchema.parse(payload);

    this.logger.debug(`${region} season ${seasonId}: ${leaderboards.length} brackets`);
    return leaderboards.map((leaderboard) => leaderboard.name);
  }

  async getLeaderboard(
    region: Region,
    seasonId: number,
    bracket: Bracket,
  ): Promise<PvpLeaderboard> {
    const payload = await this.http.get(
      region,
      `data/wow/pvp-season/${seasonId}/pvp-leaderboard/${bracket}`,
    );
    const leaderboard = pvpLeaderboardSchema.parse(payload);

    this.logger.debug(
      `${region}/${bracket} season ${seasonId}: ${leaderboard.entries.length} entries`,
    );
    return leaderboard;
  }
}
