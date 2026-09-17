import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RunLogger } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import {
  dungeonsOf,
  mainSeasonsOf,
  toDungeonDocument,
  toSeasonDocument,
} from './mplus-catalogue.mapper.js';
import { MplusCatalogueRepository } from './mplus-catalogue.repository.js';

/**
 * A hard stop for the expansion walk, far above any real expansion id. The walk
 * ends at the first expansion with no seasons; this only matters if Raider.io
 * ever answered every id with seasons, where it would otherwise never end.
 */
const MAX_EXPANSIONS_WALKED = 30;

export interface CatalogueRefresh {
  refreshed: boolean;
  /** Why nothing was fetched, when nothing was. */
  reason: string | null;
  expansions: number[];
  seasons: number;
  dungeons: number;
}

/**
 * Keeps the Mythic+ season and dungeon catalogue in step with Raider.io.
 *
 * The catalogue is small and cheap — one request per expansion, seven today —
 * but it is not static the way the archived runs are. A new season appears in
 * it before it opens, which is how the live pass learns to roll over; and a
 * running season is listed with a placeholder end (`2030-01-01`) that Raider.io
 * replaces with the real date once the season is over, which is the only way
 * the archive ever learns a season has finished. So it is re-read on a TTL
 * rather than once, and only the archived runs are strictly fetch-once.
 *
 * Three callers can ask for a refresh — the season check at boot, the live
 * pass before its first page, the archive before its backlog — and they can
 * ask at the same moment. One refresh is shared between them rather than each
 * walking every expansion.
 */
@Injectable()
export class MplusCatalogueService {
  private readonly logger = new RunLogger(MplusCatalogueService.name);
  private readonly firstExpansion: number;
  private readonly ttlMs: number;
  private inFlight: Promise<CatalogueRefresh> | null = null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: MythicPlusApi,
    private readonly repository: MplusCatalogueRepository,
  ) {
    this.firstExpansion = config.get('MPLUS_CATALOGUE_FIRST_EXPANSION', { infer: true });
    this.ttlMs = config.get('MPLUS_CATALOGUE_TTL_MS', { infer: true });
  }

  /** Refreshes the catalogue when it is empty or older than its TTL. */
  async refreshIfDue(now = new Date()): Promise<CatalogueRefresh> {
    const updatedAt = await this.repository.catalogueUpdatedAt();

    if (updatedAt && now.getTime() - updatedAt.getTime() < this.ttlMs) {
      return {
        refreshed: false,
        reason: `catalogue is fresh (read ${updatedAt.toISOString()})`,
        expansions: [],
        seasons: 0,
        dungeons: 0,
      };
    }

    return this.refresh(now);
  }

  /**
   * Walks expansions upward from the first, stopping at the first that lists
   * no seasons.
   *
   * Walked rather than configured as a list, so a new expansion is picked up
   * with no change: `expansion_id=12` answers with no seasons today and will
   * start answering with some the day Raider.io opens one.
   *
   * An expansion that fails to load stops the walk rather than being skipped.
   * Skipping would read the next id as "the one after", and a transient failure
   * on expansion 8 would then look identical to expansion 8 having ended the
   * list — the later expansions would silently go unrefreshed. What was already
   * written stays, and the next refresh starts from the beginning.
   */
  refresh(now = new Date()): Promise<CatalogueRefresh> {
    if (!this.inFlight) {
      this.inFlight = this.walk(now).finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  private async walk(now: Date): Promise<CatalogueRefresh> {
    const expansions: number[] = [];
    let seasons = 0;
    let dungeons = 0;

    for (let offset = 0; offset < MAX_EXPANSIONS_WALKED; offset += 1) {
      const expansionId = this.firstExpansion + offset;
      let data;

      try {
        data = await this.api.getStaticData(expansionId);
      } catch (error) {
        this.logger.warn(
          `Could not read the Mythic+ catalogue for expansion ${expansionId}: ` +
            `${describeError(error)}; stopping the walk here`,
        );
        break;
      }

      // The end of the list is decided on everything Raider.io lists, before
      // side events are filtered out. Decided on main seasons alone, an
      // expansion that listed only side events would end the walk and hide
      // every expansion after it.
      if (data.seasons.length === 0) break;

      const main = mainSeasonsOf(data.seasons);

      expansions.push(expansionId);
      seasons += await this.repository.upsertSeasons(
        main.map((season) => toSeasonDocument(season, expansionId, now)),
      );
      // Dungeons from main seasons too, so every stored dungeon belongs to a
      // stored season. Nothing is lost by it: the 21 main seasons list all 74.
      dungeons += await this.repository.upsertDungeons(
        dungeonsOf(main).map((dungeon) => toDungeonDocument(dungeon, now)),
        expansionId,
      );
    }

    this.logger.log(
      `Mythic+ catalogue refreshed across expansion(s) ${expansions.join(', ') || 'none'}: ` +
        `${seasons} season and ${dungeons} dungeon write(s)`,
    );

    return { refreshed: expansions.length > 0, reason: null, expansions, seasons, dungeons };
  }
}
