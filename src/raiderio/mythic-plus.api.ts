import { Injectable } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import type { RaiderIoRegion } from './raiderio.constants.js';
import {
  mythicPlusRunsSchema,
  type MythicPlusRunsPage,
} from './schemas/mythic-plus-runs.schema.js';
import { seasonCutoffsSchema, type SeasonCutoffs } from './schemas/season-cutoffs.schema.js';
import { staticDataSchema, type StaticData } from './schemas/static-data.schema.js';

/** Typed access to the Mythic+ slice of the Raider.io API. */
@Injectable()
export class MythicPlusApi {
  constructor(private readonly http: RaiderIoHttpService) {}

  /**
   * One page of the top runs for a season and region, 20 runs at a time.
   *
   * `dungeon=all` ranks every dungeon's runs into one list. Measured over the
   * top 1,200 US runs the eight dungeons are represented 90-240 times each, so
   * the aggregate board is not dominated by one dungeon — but it is still a
   * board of the best *runs*, not of each dungeon's best runs, which is what
   * bounds `mythicScore` (see `MplusCharacterDocument`).
   */
  async getRunsPage(
    season: string,
    region: RaiderIoRegion,
    page: number,
    dungeon = 'all',
  ): Promise<MythicPlusRunsPage> {
    const payload = await this.http.get('mythic-plus/runs', {
      region,
      searchParams: { season, region, dungeon, page },
    });

    return mythicPlusRunsSchema.parse(payload);
  }

  /**
   * Title and percentile cutoffs for one season in one region.
   *
   * Answers 404 for a season it has no cutoffs for — every season before
   * `season-sl-3` — and 500 for `cn` before `season-df-4`, which is the same
   * "nothing here" in a shape a caller has to tell apart for itself.
   */
  async getSeasonCutoffs(season: string, region: RaiderIoRegion): Promise<SeasonCutoffs> {
    const payload = await this.http.get('mythic-plus/season-cutoffs', {
      region,
      searchParams: { season, region },
    });

    return seasonCutoffsSchema.parse(payload).cutoffs;
  }

  /**
   * One expansion's seasons, each with its own dungeon list.
   *
   * Per expansion, not global: `expansion_id=6` answers with Legion's six
   * seasons and nothing else, so the full history is one call per expansion.
   */
  async getStaticData(expansionId: number): Promise<StaticData> {
    const payload = await this.http.get('mythic-plus/static-data', {
      searchParams: { expansion_id: expansionId },
    });

    return staticDataSchema.parse(payload);
  }
}
