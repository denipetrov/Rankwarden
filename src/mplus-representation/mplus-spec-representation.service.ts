import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema.js';
import { MongoService } from '../database/mongo.service.js';
import { MPLUS_ARCHIVE_RUNS_COLLECTION } from '../mplus-archive/entities/mplus-archive.entity.js';
import { isArchivedEverywhere } from '../mplus-archive/mplus-archive.mapper.js';
import { MPLUS_RUNS_COLLECTION } from '../mplus/entities/mplus-run.entity.js';
import type { MplusSeasonDocument } from '../mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueRepository } from '../mplus-season/mplus-catalogue.repository.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import {
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  type MplusSpecRepresentationDocument,
} from './entities/mplus-spec-representation.entity.js';
import {
  representationsOf,
  type MplusRunCount,
  type MplusSpecTally,
} from './mplus-spec-representation.mapper.js';

/** The unique index before documents were split by dungeon: one per season and region. */
const LEGACY_IDENTITY_INDEX = 'mplus_representation_identity';

/** Runs to count: a collection and the rows of it that belong to this computation. */
interface RunSource {
  collection: string;
  match: Record<string, unknown>;
}

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
 * the live board is up to 100,000 runs a region, and only the few thousand
 * (region, dungeon, spec) totals need to come back. Every other document — a
 * region over every dungeon, every region together — is summed from those.
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
    // The old identity allowed one document per season and region, so every
    // per-dungeon document would collide with it. Dropped before the new one is
    // built; absent on a fresh database, which is not an error.
    await this.collection.dropIndex(LEGACY_IDENTITY_INDEX).catch(() => undefined);

    await this.collection.createIndexes([
      // Also the front end's filter: season, then region, then dungeon — null
      // for every dungeon together.
      {
        key: { season: 1, region: 1, dungeonId: 1 },
        name: 'mplus_representation_key',
        unique: true,
      },
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

      if (entry && isArchivedEverywhere(entry, this.regions)) {
        this.logger.debug(`Mythic+ spec representation of ${season} is archived; left as it is`);
        continue;
      }

      written += await this.record(
        season,
        entry?.blizzardSeasonId ?? null,
        'live',
        this.liveSources(season, entry),
      );
    }

    return written;
  }

  /** Writes a finished season's figures from the archive. Called once, on completion. */
  async recordArchived(season: MplusSeasonDocument): Promise<number> {
    return this.record(season.slug, season.blizzardSeasonId, 'archive', [
      { collection: MPLUS_ARCHIVE_RUNS_COLLECTION, match: { season: season.slug } },
    ]);
  }

  /**
   * Where a live recomputation counts each region from.
   *
   * The live board, except for regions the archive already holds in full: a
   * season stays current in a region until its successor opens there, and the
   * season transition retires a region's live rows once the archive holds it.
   * Counted from the live board alone, that window would delete the retired
   * regions' figures and turn `all` into the regions still playing.
   *
   * Runs one clean pass missed (`missedSince`) are left out: they are on their
   * way off the board.
   */
  private liveSources(season: string, entry: MplusSeasonDocument | undefined): RunSource[] {
    const held =
      entry?.archive && entry.archive.status !== 'unarchivable'
        ? this.regions.filter((region) => entry.archive?.regions?.[region]?.status === 'complete')
        : [];
    const live: RunSource = {
      collection: MPLUS_RUNS_COLLECTION,
      match: {
        season,
        missedSince: { $exists: false },
        ...(held.length > 0 ? { region: { $nin: held } } : {}),
      },
    };

    return held.length === 0
      ? [live]
      : [
          live,
          { collection: MPLUS_ARCHIVE_RUNS_COLLECTION, match: { season, region: { $in: held } } },
        ];
  }

  /**
   * Writes the figures for every season archived everywhere that has none yet.
   *
   * The safety net under `recordArchived`: a crash between a season's marker and
   * its figures, or figures dropped by hand, would otherwise leave the season
   * without them for good, since a finished season is never archived again.
   * One distinct read when nothing is missing.
   *
   * "None" means no per-dungeon document. A season recorded before documents
   * were split by dungeon has only its all-dungeon ones, and is written again
   * once — the one time an archived season's figures are recomputed — so it
   * gains the per-dungeon breakdown every other season has.
   */
  async backfillArchived(): Promise<string[]> {
    const recorded = new Set(
      (await this.collection.distinct('season', {
        source: 'archive',
        dungeonId: { $ne: null },
      })) as string[],
    );
    const missing = (await this.catalogue.allSeasons()).filter(
      (season) =>
        isArchivedEverywhere(season, this.regions) &&
        !recorded.has(season.slug) &&
        // A season with no runs anywhere has nothing to count, and would
        // otherwise be "missing" its figures on every tick for ever.
        (season.archive?.runs ?? 0) > 0,
    );

    for (const season of missing) await this.recordArchived(season);

    return missing.map((season) => season.slug);
  }

  private async record(
    season: string,
    seasonId: number | null,
    source: MplusSpecRepresentationDocument['source'],
    sources: readonly RunSource[],
  ): Promise<number> {
    const counted = await Promise.all(sources.map((from) => this.count(from)));
    const tallies = counted.flatMap((entry) => entry.tallies);
    const runCounts = counted.flatMap((entry) => entry.runCounts);

    const computedAt = new Date();
    const documents = representationsOf({
      season,
      seasonId,
      source,
      runCounts,
      tallies,
      computedAt,
    });

    // Replaced whole, then anything this computation did not write removed — a
    // region or a dungeon no longer present — so the documents for a season
    // always describe one computation. `dungeonId: null` also matches a
    // document from before the split, which has no such field.
    for (const document of documents) {
      await this.collection.replaceOne(
        { season, region: document.region, dungeonId: document.dungeonId },
        document,
        { upsert: true },
      );
    }
    await this.collection.deleteMany({ season, computedAt: { $ne: computedAt } });

    this.logger.log(
      `Mythic+ spec representation of ${season} (${source}): ${documents.length} document(s)` +
        (documents.length > 0
          ? `, ${documents.find((document) => document.region === 'all' && document.dungeonId === null)?.slots ?? 0} roster slots`
          : ''),
    );

    return documents.length;
  }

  /** Slots per (region, dungeon, spec), and runs per (region, dungeon), in one source. */
  private async count(
    from: RunSource,
  ): Promise<{ tallies: MplusSpecTally[]; runCounts: MplusRunCount[] }> {
    const runs = this.mongo.collection(from.collection);
    const [tallies, runCounts] = await Promise.all([
      runs
        .aggregate<MplusSpecTally>(
          [
            { $match: from.match },
            { $unwind: '$roster' },
            {
              $group: {
                _id: {
                  region: '$region',
                  dungeonId: '$dungeon.id',
                  classId: '$roster.classId',
                  specId: '$roster.specId',
                },
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
                dungeonId: '$_id.dungeonId',
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
        .aggregate<MplusRunCount>([
          { $match: from.match },
          {
            $group: {
              _id: { region: '$region', dungeonId: '$dungeon.id' },
              dungeon: { $first: '$dungeon' },
              runs: { $sum: 1 },
            },
          },
          { $project: { _id: 0, region: '$_id.region', dungeon: 1, runs: 1 } },
        ])
        .toArray(),
    ]);

    return { tallies, runCounts };
  }
}
