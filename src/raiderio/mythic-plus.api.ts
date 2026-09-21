import { Injectable } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import type { RaiderIoRegion } from './raiderio.constants.js';
import {
  mythicPlusRunsSchema,
  type MythicPlusRunsPage,
} from './schemas/mythic-plus-runs.schema.js';
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
