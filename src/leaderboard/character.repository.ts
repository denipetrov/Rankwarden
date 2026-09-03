import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MongoBulkWriteError, type AnyBulkWriteOperation, type IndexDescription } from 'mongodb';

import { BRACKETS, type Bracket, type Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import { CHARACTERS_COLLECTION, type CharacterDocument } from './entities/character.entity.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';

const BULK_CHUNK_SIZE = 1_000;
const DUPLICATE_KEY = 11000;

export interface PruneResult {
  /** Characters that dropped off this bracket since the given sweep. */
  droppedBrackets: number;
  /** Characters removed entirely because they no longer rank in any bracket. */
  removedCharacters: number;
}

@Injectable()
export class CharacterRepository implements OnModuleInit {
  private readonly logger = new Logger(CharacterRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get collection() {
    return this.mongo.collection<CharacterDocument>(CHARACTERS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    const indexes: IndexDescription[] = [
      { key: { seasonId: 1, region: 1, characterId: 1 }, name: 'character_identity', unique: true },
      { key: { characterName: 1, realmSlug: 1 }, name: 'character_lookup' },
      // One per bracket: rank is what ladder views sort on.
      ...BRACKETS.map((bracket) => ({
        key: { seasonId: 1, region: 1, [`brackets.${bracket}.rank`]: 1 },
        name: `bracket_${bracket}_rank`,
      })),
    ];

    await this.collection.createIndexes(indexes);
    this.logger.log(`Indexes ensured on "${CHARACTERS_COLLECTION}"`);
  }

  /**
   * Merges a bracket's results into each character's document, creating the
   * document on first sight. Identity fields are refreshed on every sweep so
   * renames and faction changes follow along.
   */
  async upsertBracketEntries(updates: readonly CharacterBracketUpdate[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < updates.length; offset += BULK_CHUNK_SIZE) {
      const chunk = updates.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<CharacterDocument>>((update) => ({
        updateOne: {
          filter: {
            seasonId: update.seasonId,
            region: update.region,
            characterId: update.characterId,
          },
          update: {
            $set: {
              characterName: update.characterName,
              realmId: update.realmId,
              realmSlug: update.realmSlug,
              faction: update.faction,
              updatedAt: update.stats.fetchedAt,
              [`brackets.${update.bracket}`]: update.stats,
            },
            $setOnInsert: {
              seasonId: update.seasonId,
              region: update.region,
              characterId: update.characterId,
            },
          },
          upsert: true,
        },
      }));

      written += await this.writeChunk(operations);
    }

    return written;
  }

  /**
   * Two brackets of the same region are swept concurrently and now land on the
   * same character document, so an upsert can lose the race on the identity
   * index. The document exists by the time the error comes back, so replaying
   * just the losing operations settles them as plain updates.
   */
  private async writeChunk(
    operations: AnyBulkWriteOperation<CharacterDocument>[],
    replayDuplicates = true,
  ): Promise<number> {
    try {
      const result = await this.collection.bulkWrite(operations, { ordered: false });
      return result.upsertedCount + result.modifiedCount;
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError) || !replayDuplicates) {
        throw error;
      }

      const writeErrors = Array.isArray(error.writeErrors)
        ? error.writeErrors
        : [error.writeErrors];
      const duplicates = writeErrors.filter((writeError) => writeError.code === DUPLICATE_KEY);

      // Anything other than a lost upsert race is a real failure.
      if (duplicates.length !== writeErrors.length) {
        throw error;
      }

      this.logger.debug(`Replaying ${duplicates.length} upserts that raced on character identity`);
      const replayed = duplicates.map((writeError) => operations[writeError.index]);

      return (
        error.result.upsertedCount +
        error.result.modifiedCount +
        (await this.writeChunk(replayed, false))
      );
    }
  }

  /**
   * Clears bracket results that this sweep did not refresh — the character fell
   * off that ladder — and deletes characters left with no brackets at all.
   */
  async pruneBracket(
    seasonId: number,
    region: Region,
    bracket: Bracket,
    before: Date,
  ): Promise<PruneResult> {
    const dropped = await this.collection.updateMany(
      { seasonId, region, [`brackets.${bracket}.fetchedAt`]: { $lt: before } },
      { $unset: { [`brackets.${bracket}`]: '' } },
    );

    const removed = await this.collection.deleteMany({ seasonId, region, brackets: {} });

    return {
      droppedBrackets: dropped.modifiedCount,
      removedCharacters: removed.deletedCount,
    };
  }
}
