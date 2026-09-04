import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  MongoBulkWriteError,
  type AnyBulkWriteOperation,
  type Filter,
  type IndexDescription,
} from 'mongodb';

import { EXCLUDED_BRACKETS, type Bracket, type Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import {
  CHARACTERS_COLLECTION,
  type CharacterDocument,
  type CharacterProfile,
} from './entities/character.entity.js';

/** The half of a profile that comes from the character summary endpoint. */
export type ProfileSummaryFields = Pick<
  CharacterProfile,
  | 'race'
  | 'class'
  | 'level'
  | 'gender'
  | 'guild'
  | 'realmName'
  | 'title'
  | 'averageItemLevel'
  | 'equippedItemLevel'
  | 'lastLoginAt'
>;

/** The half that comes from the specializations endpoint. */
export type ProfileSpecFields = Pick<
  CharacterProfile,
  'spec' | 'heroTalentTree' | 'talentLoadouts'
>;
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
      // Enrichment selects the least recently fetched characters first;
      // never-enriched ones sort ahead of everything because the field is absent.
      { key: { specsFetchedAt: 1 }, name: 'specs_staleness' },
      { key: { profileFetchedAt: 1 }, name: 'profile_staleness' },
    ];

    await this.collection.createIndexes(indexes);
    await this.dropLegacyBracketIndexes();
    await this.purgeExcludedBrackets();
    this.logger.log(`Indexes ensured on "${CHARACTERS_COLLECTION}"`);
  }

  /**
   * Earlier builds created one index per bracket. They are superseded by
   * `bracket_ratings` and would only cost write throughput, so clear them out.
   */
  private async dropLegacyBracketIndexes(): Promise<void> {
    const legacy = (await this.collection.indexes())
      .map((index) => index.name)
      .filter((name): name is string => /^bracket_.+_rank$|^best_in_family$/.test(name ?? ''));

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
   * Clears aggregate brackets left by earlier builds. Their sweep jobs no longer
   * run, so ordinary pruning would never reach them and the misleading ratings
   * would sit in the data forever.
   */
  private async purgeExcludedBrackets(): Promise<void> {
    const unset: Record<string, ''> = {};
    for (const bracket of EXCLUDED_BRACKETS) {
      unset[`brackets.${bracket}`] = '';
      unset[`ratings.${bracket}`] = '';
    }

    // `best` was an earlier attempt at the all-specs board; the flat per-family
    // collections replaced it, so clear it out too.
    const purged = await this.collection.updateMany(
      {
        $or: [
          ...EXCLUDED_BRACKETS.map((bracket) => ({ [`brackets.${bracket}`]: { $exists: true } })),
          { best: { $exists: true } },
        ],
      },
      { $unset: { ...unset, best: '' } },
    );

    if (purged.modifiedCount === 0) return;

    // Anyone who ranked only in an aggregate bracket now ranks in nothing.
    const removed = await this.collection.deleteMany({ brackets: {} });
    this.logger.log(
      `Purged aggregate brackets from ${purged.modifiedCount} characters ` +
        `(${removed.deletedCount} left unranked and deleted)`,
    );
  }

  /**
   * The next characters due for profile enrichment. `onlyNew` restricts the
   * batch to characters a sweep has just discovered; otherwise never-enriched
   * characters still come first, because the absent field sorts ahead of dates.
   */
  async findProfilesToEnrich(
    summaryStaleBefore: Date,
    specsStaleBefore: Date,
    limit: number,
    onlyNew = false,
  ): Promise<CharacterDocument[]> {
    const filter: Filter<CharacterDocument> = onlyNew
      ? { profileFetchedAt: { $exists: false } }
      : {
          $or: [
            { profileFetchedAt: { $exists: false } },
            { profileFetchedAt: { $lt: summaryStaleBefore } },
            { specsFetchedAt: { $exists: false } },
            { specsFetchedAt: { $lt: specsStaleBefore } },
          ],
        };

    // Specs have the shorter TTL, so their timestamp is the one that paces the
    // queue: anything due for a summary refresh is necessarily due for specs too.
    return this.collection.find(filter).sort({ specsFetchedAt: 1 }).limit(limit).toArray();
  }

  /** How many characters have never had a profile fetched. */
  countUnenriched(): Promise<number> {
    return this.collection.countDocuments({ profileFetchedAt: { $exists: false } });
  }

  /**
   * Writes the summary half of a profile. Field-level so it cannot clobber the
   * spec half, which is refreshed on a different schedule.
   */
  async saveProfileSummary(
    seasonId: number,
    region: Region,
    characterId: number,
    summary: ProfileSummaryFields,
    fetchedAt: Date,
  ): Promise<void> {
    await this.collection.updateOne(
      { seasonId, region, characterId },
      {
        $set: {
          'profile.race': summary.race,
          'profile.class': summary.class,
          'profile.level': summary.level,
          'profile.gender': summary.gender,
          'profile.guild': summary.guild,
          'profile.realmName': summary.realmName,
          'profile.title': summary.title,
          'profile.averageItemLevel': summary.averageItemLevel,
          'profile.equippedItemLevel': summary.equippedItemLevel,
          'profile.lastLoginAt': summary.lastLoginAt,
          profileStatus: 'ok',
          profileFetchedAt: fetchedAt,
        },
      },
    );
  }

  /** Writes the spec half: active specialisation and hero talent tree. */
  async saveProfileSpecs(
    seasonId: number,
    region: Region,
    characterId: number,
    specs: ProfileSpecFields,
    fetchedAt: Date,
  ): Promise<void> {
    await this.collection.updateOne(
      { seasonId, region, characterId },
      {
        $set: {
          'profile.spec': specs.spec,
          'profile.heroTalentTree': specs.heroTalentTree,
          'profile.talentLoadouts': specs.talentLoadouts,
          specsFetchedAt: fetchedAt,
        },
      },
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
      {
        $set: { profileStatus: 'missing', profileFetchedAt: fetchedAt, specsFetchedAt: fetchedAt },
        $unset: { profile: '' },
      },
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
