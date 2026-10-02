import { Injectable } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import {
  RAID_RANKING_PAGE_SIZE,
  type RaidDifficulty,
  type RaidRankingRegion,
} from './raiderio.constants.js';
import { raidRankingsSchema, type RaidRanking } from './schemas/raid-rankings.schema.js';
import { raidStaticDataSchema, type RaidStaticData } from './schemas/raid-static-data.schema.js';

/** Typed access to the raiding slice of the Raider.io API. */
@Injectable()
export class RaidingApi {
  constructor(private readonly http: RaiderIoHttpService) {}

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
    const payload = await this.http.get('raiding/static-data', {
      searchParams: { expansion_id: expansionId },
    });

    return raidStaticDataSchema.parse(payload);
  }

  /**
   * One page of the ranking of one raid on one board at one difficulty, best
   * first, `RAID_RANKING_PAGE_SIZE` guilds at a time.
   *
   * `region` is a real region or `world`, whose board mixes every region's
   * guilds. A page past the end of the board — and any page of a board nobody
   * is ranked on, as Blackrock Depths has no Mythic — is 200 with an empty list;
   * a raid slug, region or difficulty the endpoint does not know is 400.
   *
   * Slow by the guild rather than by the request (see `RAID_RANKING_PAGE_SIZE`),
   * hence small pages and a timeout of its own.
   */
  async getRaidRankingsPage(
    raid: string,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    page: number,
    timeoutMs?: number,
  ): Promise<RaidRanking[]> {
    const payload = await this.http.get('raiding/raid-rankings', {
      region,
      timeoutMs,
      searchParams: {
        raid,
        difficulty,
        region,
        limit: RAID_RANKING_PAGE_SIZE,
        page,
      },
    });

    return raidRankingsSchema.parse(payload).raidRankings;
  }
}
