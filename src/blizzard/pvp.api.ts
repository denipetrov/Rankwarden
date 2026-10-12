import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fillPath } from '../common/utils/path-template.js';
import { TtlCache } from '../common/utils/ttl-cache.js';
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

export interface PvpSeasonRecord {
  id: number;
  name?: string;
  startsAt: Date;
  /** Null while the season is still running. */
  endsAt: Date | null;
}

/**
 * Typed access to the PvP slice of the Game Data API.
 *
 * Endpoint paths come from configuration (`BLIZZARD_PATH_*`), not from here.
 *
 * Two answers are reused for `BLIZZARD_REFERENCE_CACHE_TTL_MS` instead of
 * being asked for on every run: a season's bracket list, and the record of a
 * season that has finished. Everything else is read fresh every time, and
 * deliberately so — see `getSeasonIndex` and `getSeason`.
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
  private readonly brackets: TtlCache<string, readonly string[]>;
  private readonly finishedSeasons: TtlCache<string, PvpSeasonRecord>;

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

    const ttlMs = config.get('BLIZZARD_REFERENCE_CACHE_TTL_MS', { infer: true });
    this.brackets = new TtlCache(ttlMs);
    this.finishedSeasons = new TtlCache(ttlMs);
  }

  /**
   * Which season is current. Never cached: this is how a rollover is noticed,
   * and a stale answer would keep every sweep on the season that just ended.
   */
  async getSeasonIndex(region: Region): Promise<PvpSeasonIndex> {
    const payload = await this.http.get(region, fillPath(this.paths.seasonIndex));
    return pvpSeasonIndexSchema.parse(payload);
  }

  /**
   * A season's own record. `endsAt` is null while it is running and appears the
   * moment it ends, so this is worth re-reading for as long as it is null.
   *
   * Reused only once the season is over, when nothing about it can change. A
   * running season is read fresh every time: caching it would hide the end
   * date for as long as the entry lived.
   */
  async getSeason(region: Region, seasonId: number): Promise<PvpSeasonRecord> {
    const key = `${region}:${seasonId}`;
    const cached = this.finishedSeasons.get(key);
    if (cached) return { ...cached };

    const payload = await this.http.get(region, fillPath(this.paths.season, { seasonId }));
    const season = pvpSeasonSchema.parse(payload);
    const record: PvpSeasonRecord = {
      id: season.id,
      name: season.season_name ?? undefined,
      startsAt: new Date(season.season_start_timestamp),
      endsAt: season.season_end_timestamp ? new Date(season.season_end_timestamp) : null,
    };

    if (record.endsAt !== null && record.endsAt.getTime() <= Date.now()) {
      this.finishedSeasons.set(key, record);
    }

    return { ...record };
  }

  /**
   * Every bracket Blizzard publishes for a season, in the order it lists them.
   *
   * Reused between calls: the list only grows when a specialisation is added,
   * and every sweep and every archive pass asks for it. An empty list is not
   * kept, so a season whose ladders are not published yet is asked about again
   * on the next run rather than staying empty for the life of the entry.
   */
  async getBrackets(region: Region, seasonId: number): Promise<string[]> {
    const key = `${region}:${seasonId}`;
    const cached = this.brackets.get(key);
    if (cached) return [...cached];

    const payload = await this.http.get(
      region,
      fillPath(this.paths.leaderboardIndex, { seasonId }),
    );
    const { leaderboards } = pvpLeaderboardIndexSchema.parse(payload);

    this.logger.debug(`${region} season ${seasonId}: ${leaderboards.length} brackets`);
    const names = leaderboards.map((leaderboard) => leaderboard.name);
    if (names.length > 0) this.brackets.set(key, names);

    return [...names];
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
