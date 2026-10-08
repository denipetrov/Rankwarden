import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fillPath } from '../common/utils/path-template.js';
import type { Env } from '../config/env.schema.js';
import type { Bracket, Region } from './blizzard.constants.js';
import { BlizzardHttpService } from './http/blizzard-http.service.js';
import {
  pvpSeasonIndexSchema,
  pvpSeasonSchema,
  type PvpSeasonIndex,
} from './schemas/pvp-season.schema.js';
import { pvpLeaderboardSchema, type PvpLeaderboard } from './schemas/pvp-leaderboard.schema.js';
import { pvpLeaderboardIndexSchema } from './schemas/pvp-leaderboard-index.schema.js';
import {
  playableSpecializationSchema,
  pvpRewardIndexSchema,
  type PvpReward,
} from './schemas/pvp-reward.schema.js';

/**
 * Typed access to the PvP slice of the Game Data API.
 *
 * Endpoint paths come from configuration (`BLIZZARD_PATH_*`), not from here.
 */
@Injectable()
export class PvpApi {
  private readonly logger = new Logger(PvpApi.name);

  private readonly paths: {
    seasonIndex: string;
    season: string;
    leaderboardIndex: string;
    leaderboard: string;
    rewardIndex: string;
    specialization: string;
  };

  constructor(
    private readonly http: BlizzardHttpService,
    config: ConfigService<Env, true>,
  ) {
    this.paths = {
      seasonIndex: config.get('BLIZZARD_PATH_PVP_SEASON_INDEX', { infer: true }),
      season: config.get('BLIZZARD_PATH_PVP_SEASON', { infer: true }),
      leaderboardIndex: config.get('BLIZZARD_PATH_PVP_LEADERBOARD_INDEX', { infer: true }),
      leaderboard: config.get('BLIZZARD_PATH_PVP_LEADERBOARD', { infer: true }),
      rewardIndex: config.get('BLIZZARD_PATH_PVP_REWARD_INDEX', { infer: true }),
      specialization: config.get('BLIZZARD_PATH_PLAYABLE_SPECIALIZATION', { infer: true }),
    };
  }

  async getSeasonIndex(region: Region): Promise<PvpSeasonIndex> {
    const payload = await this.http.get(region, fillPath(this.paths.seasonIndex));
    return pvpSeasonIndexSchema.parse(payload);
  }

  /**
   * A season's own record. `endsAt` is null while it is running and appears the
   * moment it ends, so this is worth re-reading for as long as it is null.
   */
  async getSeason(
    region: Region,
    seasonId: number,
  ): Promise<{ id: number; name?: string; startsAt: Date; endsAt: Date | null }> {
    const payload = await this.http.get(region, fillPath(this.paths.season, { seasonId }));
    const season = pvpSeasonSchema.parse(payload);

    return {
      id: season.id,
      name: season.season_name ?? undefined,
      startsAt: new Date(season.season_start_timestamp),
      endsAt: season.season_end_timestamp ? new Date(season.season_end_timestamp) : null,
    };
  }

  /** Every bracket Blizzard publishes for a season, in the order it lists them. */
  async getBrackets(region: Region, seasonId: number): Promise<string[]> {
    const payload = await this.http.get(
      region,
      fillPath(this.paths.leaderboardIndex, { seasonId }),
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
      fillPath(this.paths.leaderboard, { seasonId, bracket }),
    );
    const leaderboard = pvpLeaderboardSchema.parse(payload);

    this.logger.debug(
      `${region}/${bracket} season ${seasonId}: ${leaderboard.entries.length} entries`,
    );
    return leaderboard;
  }

  /**
   * The titles a season awarded and the rating each one took. Served for the
   * running season too, but the cutoffs only settle once it has ended.
   */
  async getSeasonRewards(region: Region, seasonId: number): Promise<PvpReward[]> {
    const payload = await this.http.get(region, fillPath(this.paths.rewardIndex, { seasonId }));

    return pvpRewardIndexSchema.parse(payload).rewards;
  }

  /**
   * A specialisation and the class it belongs to. Rewards name a spec only by
   * id and name, and the name alone is ambiguous — Holy, Frost, Protection and
   * Restoration each exist on two classes — so the class is what turns a reward
   * into the ladder it was earned on.
   */
  async getSpecialization(
    region: Region,
    specId: number,
  ): Promise<{ id: number; name: string; className: string }> {
    const payload = await this.http.get(region, fillPath(this.paths.specialization, { specId }), {
      namespace: 'static',
    });
    const spec = playableSpecializationSchema.parse(payload);

    return { id: spec.id, name: spec.name, className: spec.playable_class.name };
  }
}
