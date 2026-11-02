import { Injectable } from '@nestjs/common';

import { UpstreamProvider } from '../common/health/upstream-provider.js';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema.js';
import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import type { RaidDifficulty, RaidRankingRegion } from './raiderio.constants.js';
import { bossRankingsSchema, type BossRanking } from './schemas/boss-rankings.schema.js';
import { raidRankingsSchema, type RaidRanking } from './schemas/raid-rankings.schema.js';
import { raidStaticDataSchema, type RaidStaticData } from './schemas/raid-static-data.schema.js';

/**
 * Typed access to the raiding slice of the Raider.io API.
 *
 * Endpoint paths come from configuration (`RAIDERIO_PATH_*`), not from here.
 */
@Injectable()
export class RaidingApi {
  private readonly staticDataPath: string;
  private readonly rankingsPath: string;
  private readonly bossRankingsPath: string;
  private readonly pageSize: number;

  constructor(
    private readonly http: RaiderIoHttpService,
    config: ConfigService<Env, true>,
  ) {
    this.staticDataPath = config.get('RAIDERIO_PATH_RAID_STATIC_DATA', { infer: true });
    this.pageSize = config.get('RAID_RANKINGS_PAGE_SIZE', { infer: true });
    this.bossRankingsPath = config.get('RAIDERIO_PATH_BOSS_RANKINGS', { infer: true });
    this.rankingsPath = config.get('RAIDERIO_PATH_RAID_RANKINGS', { infer: true });
  }

  /**
   * One expansion's raids, each with its encounters.
   *
   * Per expansion, like the Mythic+ static data: `expansion_id=6` answers with
   * Legion's five raids and nothing else. Unlike it, an expansion with no raids
   * answers **400** ("Requested unsupported expansion_id") rather than 200 with
   * an empty list — both below the first expansion listed and above the last —
   * so a caller walking expansions reads that 400 as the end of the list.
   */
  async getStaticData(expansionId: number): Promise<RaidStaticData> {
    const payload = await this.http.get(this.staticDataPath, {
      searchParams: { expansion_id: expansionId },
    });

    return raidStaticDataSchema.parse(payload);
  }

  /**
   * One page of the ranking of one raid on one board at one difficulty, best
   * first, `RAID_RANKINGS_PAGE_SIZE` guilds at a time.
   *
   * `region` is a real region or `world`, whose board mixes every region's
   * guilds. A page past the end of the board — and any page of a board nobody
   * is ranked on, as Blackrock Depths has no Mythic — is 200 with an empty list;
   * a raid slug, region or difficulty the endpoint does not know is 400.
   *
   * Slow by the guild rather than by the request (see `RAID_RANKINGS_PAGE_SIZE`),
   * hence small pages and a timeout of its own.
   */
  async getRaidRankingsPage(
    raid: string,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    page: number,
    timeoutMs?: number,
  ): Promise<RaidRanking[]> {
    const payload = await this.http.get(this.rankingsPath, {
      region,
      timeoutMs,
      healthProvider: UpstreamProvider.RaiderIoRankings,
      searchParams: {
        raid,
        difficulty,
        region,
        limit: this.pageSize,
        page,
      },
    });

    return raidRankingsSchema.parse(payload).raidRankings;
  }

  /**
   * The guilds that killed one boss of one raid first, on one board at one
   * difficulty: fifty at most, best first, in one answer — the endpoint takes
   * no `page` or `limit`, and refuses either with a 400. A boss it does not
   * know is a 400 too ("Could not find raid boss"). Fast where the raid
   * rankings are slow: 0.2-0.6s a board when checked live (2026-11-02).
   */
  async getBossRankings(
    raid: string,
    boss: string,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    timeoutMs?: number,
  ): Promise<BossRanking[]> {
    const payload = await this.http.get(this.bossRankingsPath, {
      region,
      timeoutMs,
      healthProvider: UpstreamProvider.RaiderIoRankings,
      searchParams: { raid, boss, difficulty, region },
    });

    return bossRankingsSchema.parse(payload).bossRankings;
  }
}
