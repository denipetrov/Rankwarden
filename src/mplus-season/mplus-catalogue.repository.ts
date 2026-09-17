import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import {
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
  type MplusDungeonDocument,
  type MplusSeasonArchiveMarker,
  type MplusSeasonDocument,
} from './entities/mplus-season.entity.js';

/**
 * The season and dungeon catalogue.
 *
 * Its own repository, apart from the archived runs, because two jobs read it
 * now: the live pass resolves the current season from it, and the archive
 * works its backlog from it. The archive marker is written here too, since it
 * lives on the season document.
 */
@Injectable()
export class MplusCatalogueRepository implements OnModuleInit {
  private readonly logger = new Logger(MplusCatalogueRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get seasons() {
    return this.mongo.collection<MplusSeasonDocument>(MPLUS_SEASONS_COLLECTION);
  }

  private get dungeons() {
    return this.mongo.collection<MplusDungeonDocument>(MPLUS_DUNGEONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.seasons.createIndexes([
      { key: { slug: 1 }, name: 'season_identity', unique: true },
      { key: { expansionId: 1 }, name: 'season_expansion' },
    ]);
    await this.dungeons.createIndexes([{ key: { id: 1 }, name: 'dungeon_identity', unique: true }]);

    this.logger.log(
      `Indexes ensured on "${MPLUS_SEASONS_COLLECTION}" and "${MPLUS_DUNGEONS_COLLECTION}"`,
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
}
