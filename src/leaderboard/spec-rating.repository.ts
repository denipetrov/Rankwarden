import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation, Collection } from 'mongodb';

import {
  SPEC_SPLIT_FAMILIES,
  type Bracket,
  type Region,
  type SpecSplitFamily,
} from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';
import { SPEC_RATING_COLLECTIONS, type SpecRatingDocument } from './entities/spec-rating.entity.js';

const BULK_CHUNK_SIZE = 1_000;

/**
 * Flat per-spec rating rows, one collection per family.
 *
 * Solo Shuffle and Blitz are rated per specialisation, so a board covering all
 * classes and specs has to list a character once per spec they play. That is a
 * different shape from `characters` — one row per rating rather than one document
 * per player — so it gets its own collections, ordered by a plain `rating` index.
 */
@Injectable()
export class SpecRatingRepository implements OnModuleInit {
  private readonly logger = new Logger(SpecRatingRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private collection(family: SpecSplitFamily): Collection<SpecRatingDocument> {
    return this.mongo.collection<SpecRatingDocument>(SPEC_RATING_COLLECTIONS[family]);
  }

  async onModuleInit(): Promise<void> {
    for (const family of SPEC_SPLIT_FAMILIES) {
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

    this.logger.log(
      `Indexes ensured on ${SPEC_SPLIT_FAMILIES.map((f) => `"${SPEC_RATING_COLLECTIONS[f]}"`).join(' and ')}`,
    );
  }

  /** Mirrors one bracket's leaderboard into its family's collection. */
  async upsertBracket(
    family: SpecSplitFamily,
    updates: readonly CharacterBracketUpdate[],
  ): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < updates.length; offset += BULK_CHUNK_SIZE) {
      const chunk = updates.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<SpecRatingDocument>>((update) => ({
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
    family: SpecSplitFamily,
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
    family: SpecSplitFamily,
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
