import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation, IndexDescription } from 'mongodb';

import { MongoService } from '../database/mongo.service.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
  type MplusArchiveCharacterDocument,
  type MplusArchiveRunDocument,
  type MplusDungeonDocument,
  type MplusSeasonArchiveMarker,
  type MplusSeasonDocument,
} from './entities/mplus-archive.entity.js';

const BULK_CHUNK_SIZE = 1_000;

/**
 * The season catalogue, the dungeon catalogue, and the archived runs and
 * characters.
 *
 * One repository for the same reason `MplusRepository` is one: they are written
 * by one job, and the order matters — a season's marker is written only after
 * its rows, so a crash between the two leaves rows without a marker rather than
 * a marker claiming rows that are not there.
 */
@Injectable()
export class MplusArchiveRepository implements OnModuleInit {
  private readonly logger = new Logger(MplusArchiveRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get seasons() {
    return this.mongo.collection<MplusSeasonDocument>(MPLUS_SEASONS_COLLECTION);
  }

  private get dungeons() {
    return this.mongo.collection<MplusDungeonDocument>(MPLUS_DUNGEONS_COLLECTION);
  }

  private get runs() {
    return this.mongo.collection<MplusArchiveRunDocument>(MPLUS_ARCHIVE_RUNS_COLLECTION);
  }

  private get characters() {
    return this.mongo.collection<MplusArchiveCharacterDocument>(
      MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.seasons.createIndexes([
      { key: { slug: 1 }, name: 'season_identity', unique: true },
      { key: { expansionId: 1 }, name: 'season_expansion' },
    ]);
    await this.dungeons.createIndexes([{ key: { id: 1 }, name: 'dungeon_identity', unique: true }]);

    const runIndexes: IndexDescription[] = [
      // World run ids are unique on their own; the season prefix keeps the
      // collection partitionable by season like every other one here.
      { key: { season: 1, keystoneRunId: 1 }, name: 'archive_run_identity', unique: true },
      { key: { season: 1, score: -1 }, name: 'archive_run_board' },
      { key: { season: 1, region: 1, score: -1 }, name: 'archive_run_region_board' },
      { key: { season: 1, 'dungeon.id': 1, score: -1 }, name: 'archive_run_dungeon_board' },
      { key: { season: 1, rosterKeys: 1 }, name: 'archive_run_roster' },
    ];

    const characterIndexes: IndexDescription[] = [
      { key: { season: 1, key: 1 }, name: 'archive_character_identity', unique: true },
      { key: { season: 1, mythicScore: -1 }, name: 'archive_score_board' },
      { key: { season: 1, region: 1, mythicScore: -1 }, name: 'archive_score_region_board' },
      { key: { nameKey: 1, realmSlug: 1 }, name: 'archive_character_lookup' },
    ];

    await this.runs.createIndexes(runIndexes);
    await this.characters.createIndexes(characterIndexes);

    this.logger.log(
      `Indexes ensured on "${MPLUS_SEASONS_COLLECTION}", "${MPLUS_DUNGEONS_COLLECTION}", ` +
        `"${MPLUS_ARCHIVE_RUNS_COLLECTION}" and "${MPLUS_ARCHIVE_CHARACTERS_COLLECTION}"`,
    );
  }

  /**
   * Writes one expansion's seasons into the catalogue.
   *
   * Field-level `$set` of the catalogue fields only, never the whole document:
   * `archive` lives on the same document and a wholesale replace would erase
   * the record of every season already archived the next time the catalogue
   * refreshed — and every one of them would be fetched again.
   */
  async upsertSeasons(seasons: readonly Omit<MplusSeasonDocument, 'archive'>[]): Promise<number> {
    if (seasons.length === 0) return 0;

    const result = await this.seasons.bulkWrite(
      seasons.map((season) => ({
        updateOne: { filter: { slug: season.slug }, update: { $set: season }, upsert: true },
      })),
      { ordered: false },
    );

    return result.upsertedCount + result.modifiedCount;
  }

  /**
   * Writes dungeons into the catalogue, recording each expansion that ran them.
   *
   * `$addToSet` for the expansion so a dungeon returning in a later expansion
   * accumulates rather than being relabelled with only the latest one.
   */
  async upsertDungeons(
    dungeons: readonly Omit<MplusDungeonDocument, 'expansionIds'>[],
    expansionId: number,
  ): Promise<number> {
    if (dungeons.length === 0) return 0;

    const result = await this.dungeons.bulkWrite(
      dungeons.map((dungeon) => ({
        updateOne: {
          filter: { id: dungeon.id },
          update: { $set: dungeon, $addToSet: { expansionIds: expansionId } },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    return result.upsertedCount + result.modifiedCount;
  }

  allSeasons(): Promise<MplusSeasonDocument[]> {
    return this.seasons.find({}).toArray();
  }

  countSeasons(): Promise<number> {
    return this.seasons.countDocuments();
  }

  /**
   * When the least recently refreshed season was read, or null if none ever was.
   *
   * The oldest, not the newest. A refresh that fails partway — expansion 8 down,
   * say — stamps 6 and 7 fresh and leaves the rest old; judged by the newest
   * stamp the catalogue would read as fresh and 8 onward would stay stale for a
   * whole TTL, which is exactly how a finished season goes unnoticed. Judged by
   * the oldest, a partial refresh is simply due again on the next tick.
   */
  async catalogueUpdatedAt(): Promise<Date | null> {
    const oldest = await this.seasons
      .find({}, { projection: { catalogueUpdatedAt: 1 } })
      .sort({ catalogueUpdatedAt: 1 })
      .limit(1)
      .next();

    return oldest?.catalogueUpdatedAt ?? null;
  }

  async recordArchive(slug: string, marker: MplusSeasonArchiveMarker): Promise<void> {
    await this.seasons.updateOne({ slug }, { $set: { archive: marker } });
  }

  /** Upserts archived runs by identity. Idempotent, so a retried season rewrites. */
  async upsertRuns(runs: readonly MplusArchiveRunDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < runs.length; offset += BULK_CHUNK_SIZE) {
      const chunk = runs.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusArchiveRunDocument>>((run) => ({
        updateOne: {
          filter: { season: run.season, keystoneRunId: run.keystoneRunId },
          update: { $set: run },
          upsert: true,
        },
      }));

      const result = await this.runs.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Upserts archived characters by identity.
   *
   * A plain `$set`, with none of the live collection's per-dungeon merge: a
   * finished season cannot gain a run, and the document is computed from one
   * complete read of the season, so there is nothing stored worth keeping over
   * it.
   */
  async upsertCharacters(characters: readonly MplusArchiveCharacterDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < characters.length; offset += BULK_CHUNK_SIZE) {
      const chunk = characters.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusArchiveCharacterDocument>>(
        (character) => ({
          updateOne: {
            filter: { season: character.season, key: character.key },
            update: { $set: character },
            upsert: true,
          },
        }),
      );

      const result = await this.characters.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /** What is stored for a season, for adopting one whose marker was lost. */
  async summariseStored(season: string): Promise<{ runs: number; characters: number }> {
    const [runs, characters] = await Promise.all([
      this.runs.countDocuments({ season }),
      this.characters.countDocuments({ season }),
    ]);

    return { runs, characters };
  }
}
