import { Injectable } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
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
}
