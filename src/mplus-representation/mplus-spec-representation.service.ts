import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema.js';
import { MongoService } from '../database/mongo.service.js';
import { MPLUS_ARCHIVE_RUNS_COLLECTION } from '../mplus-archive/entities/mplus-archive.entity.js';
import { regionsOwed } from '../mplus-archive/mplus-archive.mapper.js';
import { MPLUS_RUNS_COLLECTION } from '../mplus/entities/mplus-run.entity.js';
import type { MplusSeasonDocument } from '../mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueRepository } from '../mplus-season/mplus-catalogue.repository.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import {
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  type MplusSpecRepresentationDocument,
} from './entities/mplus-spec-representation.entity.js';
import { representationsOf, type MplusSpecTally } from './mplus-spec-representation.mapper.js';

/**
 * Keeps `mplus_spec_representation` in step with the runs stored.
 *
 * Two writers, one rule each:
 *
 * - **The live pass** recomputes the current season after every pass, from
 *   `mplus_runs`, so the figures move with the board.
 * - **The archive** writes a finished season once, from `mplus_archive_runs`,
 *   when the archive holds it in every region, and nothing recomputes it after.
 *
 * The rule between them: once a season is archived everywhere, the live pass
 * leaves it alone. A season stays current in a region until its successor
 * opens there (§4.6.2), so a pass can still be reading an ended season after
 * the archive has taken it — and without the rule it would overwrite the
 * archived figures on every pass until the region rolled.
 *
 * Counted in the database with one aggregation per season, not in the process:
 * the live board is up to 100,000 runs a region, and only the few hundred
 * (region, spec) totals need to come back.
 */
@Injectable()
export class MplusSpecRepresentationService implements OnModuleInit {
  private readonly logger = new Logger(MplusSpecRepresentationService.name);
  private readonly regions: RaiderIoRegion[];

  constructor(
    config: ConfigService<Env, true>,
    private readonly mongo: MongoService,
    private readonly catalogue: MplusCatalogueRepository,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
  }

  private get collection() {
    return this.mongo.collection<MplusSpecRepresentationDocument>(
      MPLUS_SPEC_REPRESENTATION_COLLECTION,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.collection.createIndexes([
      { key: { season: 1, region: 1 }, name: 'mplus_representation_identity', unique: true },
      { key: { region: 1, season: 1 }, name: 'mplus_representation_by_region' },
    ]);

    this.logger.log(`Indexes ensured on "${MPLUS_SPEC_REPRESENTATION_COLLECTION}"`);
  }

  /**
   * Recomputes the given seasons from the live board. A season the archive
   * already holds everywhere is skipped: its figures are the archive's now.
   */
  async recordLive(seasons: readonly string[]): Promise<number> {
    const catalogue = new Map(
      (await this.catalogue.allSeasons()).map((entry) => [entry.slug, entry]),
    );
    let written = 0;

    for (const season of new Set(seasons)) {
      const entry = catalogue.get(season);

      if (entry && this.isArchived(entry)) {
        this.logger.debug(`Mythic+ spec representation of ${season} is archived; left as it is`);
        continue;
      }

      written += await this.record(
        season,
        entry?.blizzardSeasonId ?? null,
        'live',
        MPLUS_RUNS_COLLECTION,
      );
    }

    return written;
  }

  /** Writes a finished season's figures from the archive. Called once, on completion. */
  async recordArchived(season: MplusSeasonDocument): Promise<number> {
    return this.record(
      season.slug,
      season.blizzardSeasonId,
      'archive',
      MPLUS_ARCHIVE_RUNS_COLLECTION,
    );
  }

  /**
   * Writes the figures for every season archived everywhere that has none yet.
   *
   * The safety net under `recordArchived`: a crash between a season's marker and
   * its figures, or figures dropped by hand, would otherwise leave the season
   * without them for good, since a finished season is never archived again.
   * One distinct read when nothing is missing.
   */
  async backfillArchived(): Promise<string[]> {
    const recorded = new Set(
      (await this.collection.distinct('season', { source: 'archive' })) as string[],
    );
    const missing = (await this.catalogue.allSeasons()).filter(
      (season) => this.isArchived(season) && !recorded.has(season.slug),
    );

    for (const season of missing) await this.recordArchived(season);

    return missing.map((season) => season.slug);
  }

  /**
   * Held in every configured region. Not `unarchivable`: such a season has no
   * archived runs to count, and stays with whatever the live board last showed.
   */
  private isArchived(season: MplusSeasonDocument): boolean {
    return (
      season.archive !== undefined &&
      season.archive.status !== 'unarchivable' &&
      regionsOwed(season, this.regions).length === 0
    );
  }

  private async record(
    season: string,
    seasonId: number | null,
    source: MplusSpecRepresentationDocument['source'],
    runsCollection: string,
  ): Promise<number> {
    const runs = this.mongo.collection(runsCollection);
    const [tallies, counts] = await Promise.all([
      runs
        .aggregate<MplusSpecTally>(
          [
            { $match: { season } },
            { $unwind: '$roster' },
            {
              $group: {
                _id: { region: '$region', classId: '$roster.classId', specId: '$roster.specId' },
                className: { $first: '$roster.className' },
                specName: { $first: '$roster.specName' },
                role: { $first: '$roster.role' },
                count: { $sum: 1 },
              },
            },
            {
              $project: {
                _id: 0,
                region: '$_id.region',
                classId: '$_id.classId',
                specId: { $ifNull: ['$_id.specId', null] },
                className: 1,
                specName: 1,
                role: 1,
                count: 1,
              },
            },
          ],
          { allowDiskUse: true },
        )
        .toArray(),
      runs
        .aggregate<{ _id: string; runs: number }>([
          { $match: { season } },
          { $group: { _id: '$region', runs: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const documents = representationsOf({
      season,
      seasonId,
      source,
      runsByRegion: new Map(counts.map((count) => [count._id, count.runs])),
      tallies,
      computedAt: new Date(),
    });

    // Replaced whole, and anything for a region no longer present removed, so
    // the documents for a season always describe one computation.
    for (const document of documents) {
      await this.collection.replaceOne({ season, region: document.region }, document, {
        upsert: true,
      });
    }
    await this.collection.deleteMany({
      season,
      region: { $nin: documents.map((document) => document.region) },
    });

    this.logger.log(
      `Mythic+ spec representation of ${season} (${source}): ${documents.length} document(s)` +
        (documents.length > 0 ? `, ${documents.at(-1)!.slots} roster slots` : ''),
    );

    return documents.length;
  }
}
