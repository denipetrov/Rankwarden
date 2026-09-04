import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  MongoBulkWriteError,
  type AnyBulkWriteOperation,
  type Filter,
  type IndexDescription,
} from 'mongodb';

import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import {
  CHARACTERS_COLLECTION,
  type CharacterDocument,
  type CharacterProfile,
} from './entities/character.entity.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';

const BULK_CHUNK_SIZE = 1_000;
const DUPLICATE_KEY = 11000;

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
      // One compound wildcard index serves ordered queries for every bracket:
      //   find({ seasonId, region, 'ratings.3v3': { $gt: 0 } }).sort({ 'ratings.3v3': -1 })
      // Measured index-ordered (no blocking sort) and 4.6x smaller than the five
      // per-bracket indexes it replaces — which could never have reached 85 anyway.
      { key: { seasonId: 1, region: 1, 'ratings.$**': 1 }, name: 'bracket_ratings' },
      // Enrichment selects the least recently profiled characters first;
      // never-enriched ones sort ahead of everything because the field is absent.
      { key: { profileFetchedAt: 1 }, name: 'profile_staleness' },
    ];

    await this.collection.createIndexes(indexes);
    await this.dropLegacyBracketIndexes();
    this.logger.log(`Indexes ensured on "${CHARACTERS_COLLECTION}"`);
  }

  /**
   * Earlier builds created one index per bracket. They are superseded by
   * `bracket_ratings` and would only cost write throughput, so clear them out.
   */
  private async dropLegacyBracketIndexes(): Promise<void> {
    const legacy = (await this.collection.indexes())
      .map((index) => index.name)
      .filter((name): name is string => /^bracket_.+_rank$/.test(name ?? ''));

    for (const name of legacy) {
      await this.collection.dropIndex(name);
      this.logger.log(`Dropped superseded index "${name}"`);
    }
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
              [`ratings.${update.bracket}`]: update.stats.rating,
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
   * The next characters due for profile enrichment. `onlyNew` restricts the
   * batch to characters a sweep has just discovered; otherwise never-enriched
   * characters still come first, because the absent field sorts ahead of dates.
   */
  async findProfilesToEnrich(
    staleBefore: Date,
    limit: number,
    onlyNew = false,
  ): Promise<CharacterDocument[]> {
    const filter: Filter<CharacterDocument> = onlyNew
      ? { profileFetchedAt: { $exists: false } }
      : {
          $or: [
            { profileFetchedAt: { $exists: false } },
            { profileFetchedAt: { $lt: staleBefore } },
          ],
        };

    return this.collection.find(filter).sort({ profileFetchedAt: 1 }).limit(limit).toArray();
  }

  /** How many characters have never had a profile fetched. */
  countUnenriched(): Promise<number> {
    return this.collection.countDocuments({ profileFetchedAt: { $exists: false } });
  }

  async saveProfile(
    seasonId: number,
    region: Region,
    characterId: number,
    profile: CharacterProfile,
    fetchedAt: Date,
  ): Promise<void> {
    await this.collection.updateOne(
      { seasonId, region, characterId },
      { $set: { profile, profileStatus: 'ok', profileFetchedAt: fetchedAt } },
    );
  }

  /**
   * Records that Blizzard has no such character. The timestamp still moves so
   * the TTL keeps it out of the queue until it is worth re-checking.
   */
  async markProfileMissing(
    seasonId: number,
    region: Region,
    characterId: number,
    fetchedAt: Date,
  ): Promise<void> {
    await this.collection.updateOne(
      { seasonId, region, characterId },
      { $set: { profileStatus: 'missing', profileFetchedAt: fetchedAt }, $unset: { profile: '' } },
    );
  }

  /**
   * Clears a bracket result this sweep did not refresh — the character fell off
   * that ladder. Both the payload and its mirrored rating go.
   */
  async pruneBracket(
    seasonId: number,
    region: Region,
    bracket: Bracket,
    before: Date,
  ): Promise<number> {
    const dropped = await this.collection.updateMany(
      { seasonId, region, [`brackets.${bracket}.fetchedAt`]: { $lt: before } },
      { $unset: { [`brackets.${bracket}`]: '', [`ratings.${bracket}`]: '' } },
    );

    return dropped.modifiedCount;
  }

  /**
   * Deletes characters left ranking in nothing. Runs once per region at the end
   * of a sweep rather than per bracket — with 85 brackets that is 85 collection
   * scans saved.
   */
  async removeUnranked(seasonId: number, region: Region): Promise<number> {
    const removed = await this.collection.deleteMany({ seasonId, region, brackets: {} });
    return removed.deletedCount;
  }
}
