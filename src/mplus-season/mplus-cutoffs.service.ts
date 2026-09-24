import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RunLogger } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type { MplusSeasonCutoffs } from './entities/mplus-cutoffs.entity.js';
import type { MplusSeasonDocument } from './entities/mplus-season.entity.js';
import { toSeasonCutoffs } from './mplus-cutoffs.mapper.js';
import { MplusCatalogueRepository } from './mplus-catalogue.repository.js';

/**
 * Tries before a region's cutoffs are given up on.
 *
 * Three, because the failure this guards against is not transient: `cn` answers
 * 500 — not 404 — for every season before `season-df-4`, so without a cap the
 * archive would ask again on every tick for ever. Three still absorbs a real
 * outage across three ticks.
 */
const MAX_ATTEMPTS = 3;

/**
 * Reads title and percentile cutoffs from Raider.io onto the season catalogue.
 *
 * One request per season and region, so the figures a board shows — Keystone
 * Master, Hero, Legend, and the top 0.1% and 1% titles — come from Raider.io's
 * own computation over the **whole** ladder rather than being inferred from the
 * runs stored here, which are only the top of each board.
 *
 * Two callers, the same split as spec representation (§5.9):
 *
 * - **The live pass** re-reads the current season's regions on every pass, five
 *   requests, because a running season's cutoffs move as people play.
 * - **The archive** reads a finished season once per region and never again.
 *
 * A region is asked once and then left alone unless it is the live season: a
 * 404 is recorded as `missing` (no season before `season-sl-3` has cutoffs) and
 * repeated failures as `unavailable`.
 */
@Injectable()
export class MplusCutoffsService {
  private readonly logger = new RunLogger(MplusCutoffsService.name);
  private readonly regions: RaiderIoRegion[];

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: MythicPlusApi,
    private readonly repository: MplusCatalogueRepository,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
  }

  /**
   * Re-reads the cutoffs of the season current in each region.
   *
   * `ok` is not settled here: a live season's cutoffs change with every run
   * played, so they are read again on each pass. A season already archived
   * everywhere is left to the archive's copy, as its representation is.
   */
  async recordLive(current: ReadonlyMap<RaiderIoRegion, string>): Promise<number> {
    const catalogue = new Map(
      (await this.repository.allSeasons()).map((season) => [season.slug, season]),
    );
    let read = 0;

    for (const [region, season] of current) {
      // Archived everywhere: the figures are final, and the archive read them.
      if (catalogue.get(season)?.archive?.status === 'complete') continue;

      const stored = catalogue.get(season)?.cutoffs?.[region];
      // A region given up on stays given up on, even while the season is live.
      if (stored?.status === 'missing' || stored?.status === 'unavailable') continue;

      if (await this.record(season, region, stored)) read += 1;
    }

    return read;
  }

  /**
   * Reads the cutoffs a finished season still owes, once per region.
   *
   * Called as a season is archived, and again by the backfill for a season
   * archived before this existed or left with a region outstanding.
   */
  async recordSeason(season: MplusSeasonDocument): Promise<number> {
    let read = 0;

    for (const region of this.regions) {
      const stored = season.cutoffs?.[region];
      if (this.isSettled(stored)) continue;

      if (await this.record(season.slug, region, stored)) read += 1;
    }

    return read;
  }

  /**
   * Reads what the seasons given still owe. Returns the seasons it touched.
   *
   * Costs one database read when nothing is owed, which is the usual case: a
   * region is settled the first time it is asked.
   */
  async backfill(seasons: readonly MplusSeasonDocument[]): Promise<string[]> {
    const touched: string[] = [];

    for (const season of seasons) {
      if (this.regions.every((region) => this.isSettled(season.cutoffs?.[region]))) continue;

      await this.recordSeason(season);
      touched.push(season.slug);
    }

    return touched;
  }

  /** Read, known absent, or given up on: anything but "ask again". */
  private isSettled(cutoffs: MplusSeasonCutoffs | undefined): boolean {
    return cutoffs !== undefined && cutoffs.status !== 'failed';
  }

  /** One region. Returns whether cutoffs were read; a failure is recorded, never thrown. */
  private async record(
    season: string,
    region: RaiderIoRegion,
    stored: MplusSeasonCutoffs | undefined,
  ): Promise<boolean> {
    const fetchedAt = new Date();

    try {
      const cutoffs = await this.api.getSeasonCutoffs(season, region);
      await this.repository.recordCutoffs(season, region, toSeasonCutoffs(cutoffs, fetchedAt));

      return true;
    } catch (error) {
      const reason = describeError(error);
      const missing = error instanceof RaiderIoApiError && error.isNotFound;
      const attempts = (stored?.attempts ?? 0) + 1;
      const status = missing
        ? 'missing'
        : attempts >= MAX_ATTEMPTS
          ? 'unavailable'
          : ('failed' as const);

      // The shape is kept whole even on a failure, so a reader never has to
      // branch on which half of the document exists.
      await this.repository.recordCutoffs(season, region, {
        status,
        updatedAt: stored?.updatedAt ?? null,
        keystones: stored?.keystones ?? {},
        quantiles: stored?.quantiles ?? {},
        fetchedAt,
        attempts,
        lastError: reason,
      });

      this.logger[missing ? 'log' : 'warn'](
        missing
          ? `Raider.io has no Mythic+ cutoffs for ${season} in ${region}; recorded as missing`
          : `Could not read Mythic+ cutoffs for ${season} in ${region} (attempt ${attempts}` +
              `${status === 'unavailable' ? ', giving up' : ''}): ${reason}`,
      );

      return false;
    }
  }
}
