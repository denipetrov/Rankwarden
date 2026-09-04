import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation, Collection } from 'mongodb';

import {
  ratingFamilyOf,
  RATING_FAMILIES,
  type Bracket,
  type Region,
  type RatingFamily,
} from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';
import { CHARACTERS_COLLECTION } from './entities/character.entity.js';
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

  /**
   * Deletes rows belonging to characters that no longer exist.
   *
   * Per-bracket pruning already removes a row when a character leaves that
   * ladder, but it can only act on brackets the sweep actually visited. A
   * character deleted outright, or one whose bracket Blizzard stopped
   * publishing, would leave rows behind that no board should ever show. This
   * reconciles against `characters`, which is the record of who exists.
   */
  async removeOrphans(seasonId: number, region: Region): Promise<number> {
    const known = new Set(
      await this.mongo
        .collection(CHARACTERS_COLLECTION)
        .distinct('characterId', { seasonId, region }),
    );

    let removed = 0;

    for (const family of RATING_FAMILIES) {
      const collection = this.collection(family);
      const present = await collection.distinct('characterId', { seasonId, region });
      const orphans = present.filter((characterId) => !known.has(characterId));

      for (let offset = 0; offset < orphans.length; offset += BULK_CHUNK_SIZE) {
        const chunk = orphans.slice(offset, offset + BULK_CHUNK_SIZE);
        const result = await collection.deleteMany({
          seasonId,
          region,
          characterId: { $in: chunk },
        });
        removed += result.deletedCount;
      }
    }

    if (removed > 0) {
      this.logger.log(`Removed ${removed} orphaned rating rows in ${region}`);
    }

    return removed;
  }

  /**
   * Drops rows for brackets Blizzard no longer publishes.
   *
   * Per-bracket pruning only runs for brackets the sweep visited, so a ladder
   * that disappears — a specialisation removed between expansions, say — would
   * otherwise keep its rows forever, still ordered onto boards.
   */
  async removeRetiredBrackets(
    seasonId: number,
    region: Region,
    liveBrackets: readonly Bracket[],
  ): Promise<number> {
    // An empty list means the sweep failed for this region, not that every
    // bracket retired. Deleting on that basis would wipe the region.
    if (liveBrackets.length === 0) return 0;

    let removed = 0;

    for (const family of RATING_FAMILIES) {
      const live = liveBrackets.filter((bracket) => ratingFamilyOf(bracket) === family);
      if (live.length === 0) continue;

      const result = await this.collection(family).deleteMany({
        seasonId,
        region,
        bracket: { $nin: live },
      });
      removed += result.deletedCount;
    }

    if (removed > 0) {
      this.logger.log(`Removed ${removed} rating rows for retired brackets in ${region}`);
    }

    return removed;
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
