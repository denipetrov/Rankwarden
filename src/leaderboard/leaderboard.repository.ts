import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation } from 'mongodb';

import { MongoService } from '../database/mongo.service.js';
import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
import {
  LEADERBOARD_COLLECTION,
  type LeaderboardEntryDocument,
} from './entities/leaderboard-entry.entity.js';

const BULK_CHUNK_SIZE = 1_000;

@Injectable()
export class LeaderboardRepository implements OnModuleInit {
  private readonly logger = new Logger(LeaderboardRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get collection() {
    return this.mongo.collection<LeaderboardEntryDocument>(LEADERBOARD_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.collection.createIndexes([
      {
        key: { seasonId: 1, region: 1, bracket: 1, characterId: 1 },
        name: 'entry_identity',
        unique: true,
      },
      { key: { seasonId: 1, region: 1, bracket: 1, rank: 1 }, name: 'bracket_rank' },
      { key: { characterId: 1 }, name: 'character' },
    ]);
    this.logger.log(`Indexes ensured on "${LEADERBOARD_COLLECTION}"`);
  }

  /** Upserts a full bracket snapshot, chunked to keep bulk payloads bounded. */
  async upsertMany(entries: readonly LeaderboardEntryDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < entries.length; offset += BULK_CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations: AnyBulkWriteOperation<LeaderboardEntryDocument>[] = chunk.map((entry) => ({
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

      const result = await this.collection.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /** Drops entries left behind by a previous sweep (characters that fell off the ladder). */
  async pruneStale(
    seasonId: number,
    region: Region,
    bracket: Bracket,
    before: Date,
  ): Promise<number> {
    const result = await this.collection.deleteMany({
      seasonId,
      region,
      bracket,
      fetchedAt: { $lt: before },
    });
    return result.deletedCount;
  }
}
