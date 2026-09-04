import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation, Collection } from 'mongodb';

import {
  RATING_FAMILIES,
  type Bracket,
  type Region,
  type RatingFamily,
} from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';
import { RATING_COLLECTIONS, type RatingDocument } from './entities/rating.entity.js';

const BULK_CHUNK_SIZE = 1_000;

/**
 * Flat rating rows, one collection per ladder family.
 *
 * One row per rating rather than one document per player: 2v2, 3v3 and rbg give
 * a character a single row each, while shuffle and blitz give them one per spec
 * they have played. Every board is then a sorted range scan over one collection,
 * with display data joined from `characters` afterwards.
 */
@Injectable()
export class RatingRepository implements OnModuleInit {
  private readonly logger = new Logger(RatingRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private collection(family: RatingFamily): Collection<RatingDocument> {
    return this.mongo.collection<RatingDocument>(RATING_COLLECTIONS[family]);
  }

  async onModuleInit(): Promise<void> {
    for (const family of RATING_FAMILIES) {
      await this.collection(family).createIndexes([
        // The board itself: a sorted range scan across every spec at once.
        { key: { seasonId: 1, region: 1, rating: -1 }, name: 'board_order' },
        {
          key: { seasonId: 1, region: 1, bracket: 1, characterId: 1 },
          name: 'entry_identity',
          unique: true,
        },
        // "Every rating this character holds", for a character page.
        { key: { characterId: 1 }, name: 'character' },
      ]);
    }

    this.logger.log(`Indexes ensured on ${RATING_FAMILIES.length} ratings collections`);
  }

  /** Mirrors one bracket's leaderboard into its family's collection. */
  async upsertBracket(
    family: RatingFamily,
    updates: readonly CharacterBracketUpdate[],
  ): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < updates.length; offset += BULK_CHUNK_SIZE) {
      const chunk = updates.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<RatingDocument>>((update) => ({
        updateOne: {
          filter: {
            seasonId: update.seasonId,
            region: update.region,
            bracket: update.bracket,
            characterId: update.characterId,
          },
          update: {
            $set: {
              rating: update.stats.rating,
              fetchedAt: update.stats.fetchedAt,
            },
            $setOnInsert: {
              seasonId: update.seasonId,
              region: update.region,
              bracket: update.bracket,
              characterId: update.characterId,
            },
          },
          upsert: true,
        },
      }));

      const result = await this.collection(family).bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Makes one character's rows in a family match the brackets given exactly.
   * Rows for brackets absent from the list are deleted, so a character who has
   * stopped playing a spec drops off that board.
   */
  async replaceForCharacter(
    family: RatingFamily,
    seasonId: number,
    region: Region,
    characterId: number,
    updates: readonly CharacterBracketUpdate[],
  ): Promise<{ written: number; removed: number }> {
    const written = updates.length > 0 ? await this.upsertBracket(family, updates) : 0;

    const removed = await this.collection(family).deleteMany({
      seasonId,
      region,
      characterId,
      bracket: { $nin: updates.map((update) => update.bracket) },
    });

    return { written, removed: removed.deletedCount };
  }

  /** Drops rows this sweep did not refresh — the character left that ladder. */
  async pruneBracket(
    family: RatingFamily,
    seasonId: number,
    region: Region,
    bracket: Bracket,
    before: Date,
  ): Promise<number> {
    const result = await this.collection(family).deleteMany({
      seasonId,
      region,
      bracket,
      fetchedAt: { $lt: before },
    });

    return result.deletedCount;
  }
}
