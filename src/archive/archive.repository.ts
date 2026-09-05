import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation } from 'mongodb';

import type { Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import {
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
  type ArchiveEntryDocument,
  type ArchiveSeasonDocument,
} from './entities/archive.entity.js';

const BULK_CHUNK_SIZE = 1_000;

@Injectable()
export class ArchiveRepository implements OnModuleInit {
  private readonly logger = new Logger(ArchiveRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get entries() {
    return this.mongo.collection<ArchiveEntryDocument>(ARCHIVE_ENTRIES_COLLECTION);
  }

  private get seasons() {
    return this.mongo.collection<ArchiveSeasonDocument>(ARCHIVE_SEASONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.entries.createIndexes([
      // A past season's ladder, ordered.
      { key: { seasonId: 1, region: 1, bracket: 1, rating: -1 }, name: 'archive_board' },
      // Idempotent re-runs: archiving a season twice must not duplicate it.
      {
        key: { seasonId: 1, region: 1, bracket: 1, characterId: 1 },
        name: 'archive_identity',
        unique: true,
      },
      // One character's history across seasons.
      { key: { characterId: 1, seasonId: -1 }, name: 'archive_character' },
    ]);

    await this.seasons.createIndexes([
      { key: { seasonId: 1, region: 1 }, name: 'season_identity', unique: true },
    ]);

    this.logger.log(`Indexes ensured on "${ARCHIVE_ENTRIES_COLLECTION}"`);
  }

  /** Season/region pairs already archived with nothing left to retry. */
  async completedSeasons(): Promise<Set<string>> {
    const done = await this.seasons
      .find({ failedBrackets: { $size: 0 } }, { projection: { seasonId: 1, region: 1 } })
      .toArray();

    return new Set(done.map((entry) => `${entry.seasonId}:${entry.region}`));
  }

  /**
   * Cheap "do we already hold this season?" probe: a few random brackets, a
   * handful of rows each. Historical data never changes, so finding rows is
   * reason enough not to spend ~85 requests fetching them again.
   *
   * Deliberately a sample rather than a count — the point is to avoid work, not
   * to swap one expensive operation for another. It cannot tell a complete
   * season from a partial one, which is what `archive_seasons` is for; this only
   * answers whether anything is there at all.
   */
  async hasStoredEntries(
    seasonId: number,
    region: Region,
    sampleBrackets = 3,
    perBracket = 10,
  ): Promise<boolean> {
    const brackets = await this.entries.distinct('bracket', { seasonId, region });
    if (brackets.length === 0) return false;

    const sample = [...brackets].sort(() => Math.random() - 0.5).slice(0, sampleBrackets);

    for (const bracket of sample) {
      const rows = await this.entries
        .find({ seasonId, region, bracket }, { projection: { _id: 1 } })
        .limit(perBracket)
        .toArray();

      if (rows.length === 0) return false;
    }

    return true;
  }

  /** Counts what is actually stored, so a recovered marker reflects reality. */
  async summariseStored(
    seasonId: number,
    region: Region,
  ): Promise<{ brackets: number; entries: number }> {
    const [brackets, entries] = await Promise.all([
      this.entries.distinct('bracket', { seasonId, region }),
      this.entries.countDocuments({ seasonId, region }),
    ]);

    return { brackets: brackets.length, entries };
  }

  async insertEntries(entries: readonly ArchiveEntryDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < entries.length; offset += BULK_CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<ArchiveEntryDocument>>((entry) => ({
        updateOne: {
          filter: {
            seasonId: entry.seasonId,
            region: entry.region,
            bracket: entry.bracket,
            characterId: entry.characterId,
          },
          update: { $set: entry },
          upsert: true,
        },
      }));

      const result = await this.entries.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  async recordSeason(season: ArchiveSeasonDocument): Promise<void> {
    const { seasonId, region, ...rest } = season;

    await this.seasons.updateOne(
      { seasonId, region },
      { $set: rest, $setOnInsert: { seasonId, region } },
      { upsert: true },
    );
  }

  countEntries(seasonId: number, region: Region): Promise<number> {
    return this.entries.countDocuments({ seasonId, region });
  }
}
