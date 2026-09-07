import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation } from 'mongodb';

import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
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

  /**
   * Season/region pairs that need no further work: archived in full, or known
   * to be unfetchable. Both are skipped, for different reasons.
   */
  async settledSeasons(): Promise<Set<string>> {
    const done = await this.seasons
      .find(
        { $or: [{ failedBrackets: { $size: 0 } }, { unarchivable: true }] },
        { projection: { seasonId: 1, region: 1 } },
      )
      .toArray();

    return new Set(done.map((entry) => `${entry.seasonId}:${entry.region}`));
  }

  /**
   * What is actually stored for a season, brackets named rather than counted.
   *
   * The names are what makes a partial season recoverable: a crash mid-archive
   * leaves rows with no marker, and the only way to tell 83 of 83 brackets from
   * 3 of 83 is to compare these against the bracket list the API publishes.
   * A sampling probe cannot do it — `distinct` only ever lists brackets that
   * are present, so it finds rows either way.
   */
  async summariseStored(
    seasonId: number,
    region: Region,
  ): Promise<{ brackets: Bracket[]; entries: number }> {
    const [brackets, entries] = await Promise.all([
      this.entries.distinct('bracket', { seasonId, region }),
      this.entries.countDocuments({ seasonId, region }),
    ]);

    return { brackets, entries };
  }

  /**
   * Marks a season the API will never serve, so it stops holding up everything
   * behind it in the backlog. Seasons below 22 return 404 permanently.
   */
  async markUnarchivable(seasonId: number, region: Region, reason: string): Promise<void> {
    await this.seasons.updateOne(
      { seasonId, region },
      {
        $set: { unarchivable: true, lastError: reason, archivedAt: new Date() },
        $setOnInsert: {
          seasonId,
          region,
          startsAt: null,
          endsAt: null,
          brackets: 0,
          entries: 0,
          failedBrackets: [],
        },
      },
      { upsert: true },
    );
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
