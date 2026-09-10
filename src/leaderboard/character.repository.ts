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

/** Profile fields owned by the character summary endpoint. */
export const PROFILE_SUMMARY_KEYS = [
  'race',
  'class',
  'level',
  'gender',
  'guild',
  'realmName',
  'title',
  'averageItemLevel',
  'equippedItemLevel',
  'lastLoginAt',
] as const satisfies readonly (keyof CharacterProfile)[];

/** Profile fields owned by the specializations endpoint. */
export const PROFILE_SPEC_KEYS = [
  'spec',
  'heroTalentTree',
  'talentLoadouts',
] as const satisfies readonly (keyof CharacterProfile)[];

export type ProfileSummaryFields = Pick<CharacterProfile, (typeof PROFILE_SUMMARY_KEYS)[number]>;
export type ProfileSpecFields = Pick<CharacterProfile, (typeof PROFILE_SPEC_KEYS)[number]>;
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';

const BULK_CHUNK_SIZE = 1_000;
const DUPLICATE_KEY = 11000;

/** Indexes an earlier build created and a later one replaced. */
const SUPERSEDED_INDEXES = new Set(['specs_staleness', 'profile_staleness']);

/**
 * The characters enrichment serves at all. Only ladder characters need it:
 * every other type arrives with its profile already bundled in.
 */
const ENRICHABLE = { characterType: 'PvP' } as const satisfies Filter<CharacterDocument>;

/**
 * The characters enrichment would pick, shared by selection and by the demand
 * count so the two can never disagree about which set they mean.
 *
 * Exported so the integration suite can explain it against a real query plan.
 */
export function enrichmentFilter(
  summaryStaleBefore: Date,
  specsStaleBefore: Date,
  onlyNew: boolean,
): Filter<CharacterDocument> {
  if (onlyNew) return { ...ENRICHABLE, profileFetchedAt: { $exists: false } };

  return {
    ...ENRICHABLE,
    $or: [
      { profileFetchedAt: { $exists: false } },
      { profileFetchedAt: { $lt: summaryStaleBefore } },
      { specsFetchedAt: { $exists: false } },
      { specsFetchedAt: { $lt: specsStaleBefore } },
    ],
  };
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
      // One compound wildcard index serves ordered queries for every bracket:
      //   find({ seasonId, region, 'ratings.3v3': { $gt: 0 } }).sort({ 'ratings.3v3': -1 })
      // Measured index-ordered (no blocking sort) and 4.6x smaller than the five
      // per-bracket indexes it replaces — which could never have reached 85 anyway.
      { key: { seasonId: 1, region: 1, 'ratings.$**': 1 }, name: 'bracket_ratings' },
      // Enrichment selects the least recently fetched characters first;
      // never-enriched ones sort ahead of everything because the field is absent.
      // Led by the type because characters that are never enriched never get a
      // timestamp either: without the prefix they would sit at the very front
      // of the timestamp order, and every run would walk past all of them
      // before reaching the first character it can use.
      { key: { characterType: 1, specsFetchedAt: 1 }, name: 'enrichment_specs_staleness' },
      { key: { characterType: 1, profileFetchedAt: 1 }, name: 'enrichment_profile_staleness' },
    ];

    await this.collection.createIndexes(indexes);
    await this.dropSupersededIndexes();
    await this.backfillCharacterType();
    await this.purgeExcludedBrackets();
    this.logger.log(`Indexes ensured on "${CHARACTERS_COLLECTION}"`);
  }

  /**
   * Clears indexes a later build replaced. Earlier builds created one per
   * bracket, superseded by `bracket_ratings`; and the staleness indexes before
   * they were led by `characterType`. Either kind would only cost write
   * throughput. Runs after `createIndexes`, so enrichment is never left without
   * an index to select by.
   */
  private async dropSupersededIndexes(): Promise<void> {
    const superseded = (await this.collection.indexes())
      .map((index) => index.name)
      .filter(
        (name): name is string =>
          /^bracket_.+_rank$|^best_in_family$/.test(name ?? '') ||
          SUPERSEDED_INDEXES.has(name ?? ''),
      );

    for (const name of superseded) {
      await this.collection.dropIndex(name);
      this.logger.log(`Dropped superseded index "${name}"`);
    }
  }

  /**
   * Stamps a type on characters stored before the field existed. The ladder
   * sweep was the only way a character could get into the collection then, so
   * every one of them is `PvP`.
   *
   * This has to finish before any scheduler starts: enrichment selects by type,
   * and an untyped character would simply never be picked up again.
   */
  private async backfillCharacterType(): Promise<void> {
    const backfilled = await this.collection.updateMany(
      { characterType: { $exists: false } },
      { $set: { characterType: 'PvP' } },
    );

    if (backfilled.modifiedCount > 0) {
      this.logger.log(`Backfilled characterType "PvP" on ${backfilled.modifiedCount} characters`);
    }
  }

  /**
   * Merges a bracket's results into each character's document, creating the
   * document on first sight. Identity fields are refreshed on every sweep so
   * renames and faction changes follow along.
   *
   * A character the sweep creates is `PvP`. The type is set on insert only: the
   * sweep reclassifying a document some other source created would put it in
   * the enrichment queue and spend quota on a profile that source already has.
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
              characterType: 'PvP',
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
    const filter = enrichmentFilter(summaryStaleBefore, specsStaleBefore, onlyNew);

    // Specs have the shorter TTL, so their timestamp is the one that paces the
    // queue: anything due for a summary refresh is necessarily due for specs too.
    return this.collection.find(filter).sort({ specsFetchedAt: 1 }).limit(limit).toArray();
  }

  /**
   * How much enrichment work is due: characters, and the requests they need.
   *
   * Uses the same filter selection does, deliberately — a batch sized from a
   * count of a different set would buy the wrong number of characters. A
   * character due for both halves costs two requests, one due for specs alone
   * costs one, so the request total is the two half-counts added rather than
   * the character count doubled.
   */
  async countEnrichmentDemand(
    summaryStaleBefore: Date,
    specsStaleBefore: Date,
    onlyNew = false,
  ): Promise<{ characters: number; requests: number }> {
    const base = enrichmentFilter(summaryStaleBefore, specsStaleBefore, onlyNew);
    const summaryStale: Filter<CharacterDocument> = {
      $or: [
        { profileFetchedAt: { $exists: false } },
        { profileFetchedAt: { $lt: summaryStaleBefore } },
      ],
    };
    const specsStale: Filter<CharacterDocument> = {
      $or: [{ specsFetchedAt: { $exists: false } }, { specsFetchedAt: { $lt: specsStaleBefore } }],
    };

    const [characters, summaryDue, specsDue] = await Promise.all([
      this.collection.countDocuments(base),
      this.collection.countDocuments({ $and: [base, summaryStale] }),
      this.collection.countDocuments({ $and: [base, specsStale] }),
    ]);

    return { characters, requests: summaryDue + specsDue };
  }

  /**
   * Characters enrichment serves. A real count rather than collection metadata
   * now that characters needing no enrichment share the collection. It is
   * answered from the prefix of the staleness index, so it stays cheap.
   */
  population(): Promise<number> {
    return this.collection.countDocuments(ENRICHABLE);
  }

  /**
   * The stalest spec refresh among characters that have had one, or null.
   * Never-enriched characters are excluded: a backlog on first fill is not the
   * same thing as a queue that has stopped keeping up.
   */
  async oldestSpecsRefresh(): Promise<Date | null> {
    const oldest = await this.collection
      .find(
        { ...ENRICHABLE, specsFetchedAt: { $exists: true } },
        { projection: { specsFetchedAt: 1 } },
      )
      .sort({ specsFetchedAt: 1 })
      .limit(1)
      .next();

    return oldest?.specsFetchedAt ?? null;
  }

  /** How many enrichable characters have never had a profile fetched. */
  countUnenriched(): Promise<number> {
    return this.collection.countDocuments({ ...ENRICHABLE, profileFetchedAt: { $exists: false } });
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
   * Records that one half of a character's profile could not be read, and
   * stamps that half so the character yields its place in the queue.
   *
   * The stamp is the whole point. Selection sorts by the fetch timestamps
   * ascending and an absent field sorts before every date, so a character that
   * fails without being stamped is re-selected on every pass forever. Once
   * enough of them accumulate to fill a batch, nothing else is ever enriched
   * again — and the job goes on reporting successful runs while it happens.
   *
   * Whatever profile data is already stored is left alone: unlike a 404, the
   * character still exists, and stale-but-real data beats no data.
   */
  async markProfileUnreadable(
    seasonId: number,
    region: Region,
    characterId: number,
    half: 'summary' | 'specs',
    retryAfter: Date,
    permanent: boolean,
  ): Promise<void> {
    const field = half === 'summary' ? 'profileFetchedAt' : 'specsFetchedAt';

    await this.collection.updateOne(
      { seasonId, region, characterId },
      {
        $set: {
          [field]: retryAfter,
          // Only a schema failure is worth flagging on the document; a timeout
          // says nothing about the character and would just churn the field.
          ...(permanent ? { profileStatus: 'unparseable' as const } : {}),
        },
      },
    );
  }

  /**
   * Updates an existing character from the sync endpoint. Never inserts: a
   * character absent here holds no rating we care about, and creating one would
   * fill the collection with players no ladder lists.
   *
   * Ladder data is authoritative for every bracket at once, so `brackets` and
   * `ratings` are set wholesale. The profile is merged field by field instead —
   * a caller that knows a character's race must not blank their spec by omitting
   * it — and only the halves actually supplied get their enrichment timestamp
   * stamped, so the worker still fills in whatever was left out.
   */
  async updateCharacter(
    // No `characterType`: this never inserts, so the type is whatever the
    // document was created with.
    document: Omit<
      CharacterDocument,
      'characterType' | 'profile' | 'profileStatus' | 'profileFetchedAt' | 'specsFetchedAt'
    >,
    profile?: Partial<CharacterProfile>,
  ): Promise<{ matched: boolean }> {
    const { seasonId, region, characterId, ...fields } = document;
    const update: Record<string, unknown> = { ...fields };

    if (profile) {
      const supplied = (keys: readonly (keyof CharacterProfile)[]) =>
        keys.some((key) => profile[key] !== undefined);

      for (const [key, value] of Object.entries(profile)) {
        if (value !== undefined) update[`profile.${key}`] = value;
      }

      if (supplied(PROFILE_SUMMARY_KEYS)) {
        update.profileStatus = 'ok';
        update.profileFetchedAt = document.updatedAt;
      }
      if (supplied(PROFILE_SPEC_KEYS)) {
        update.specsFetchedAt = document.updatedAt;
      }
    }

    const result = await this.collection.updateOne(
      { seasonId, region, characterId },
      { $set: update },
    );

    return { matched: result.matchedCount > 0 };
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
   * Clears brackets Blizzard no longer publishes.
   *
   * `pruneBracket` only runs for brackets the sweep visited, and a retired
   * ladder is by definition not visited — so without this its results stay on
   * the document, its rating stays queryable through the `bracket_ratings`
   * wildcard index, and a character who ranked only in retired brackets never
   * reaches `brackets: {}` for `removeUnranked` to delete.
   */
  async removeRetiredBrackets(
    seasonId: number,
    region: Region,
    liveBrackets: readonly Bracket[],
  ): Promise<number> {
    // An empty list means the sweep failed for this region, not that every
    // bracket retired. Unsetting on that basis would strip the whole region.
    if (liveBrackets.length === 0) return 0;

    const live = new Set(liveBrackets);
    const stored = await this.storedBrackets(seasonId, region);
    const retired = stored.filter((bracket) => !live.has(bracket));

    if (retired.length === 0) return 0;

    const unset: Record<string, ''> = {};
    for (const bracket of retired) {
      unset[`brackets.${bracket}`] = '';
      unset[`ratings.${bracket}`] = '';
    }

    const cleared = await this.collection.updateMany(
      {
        seasonId,
        region,
        $or: retired.map((bracket) => ({ [`brackets.${bracket}`]: { $exists: true } })),
      },
      { $unset: unset },
    );

    if (cleared.modifiedCount > 0) {
      this.logger.log(
        `Cleared ${retired.length} retired bracket(s) from ${cleared.modifiedCount} ` +
          `characters in ${region}: ${retired.join(', ')}`,
      );
    }

    return cleared.modifiedCount;
  }

  /**
   * Every bracket key actually present on a region's documents. Read from
   * `ratings` rather than `brackets` because it is the smaller of the two
   * mirrored maps, and they always carry the same keys.
   */
  private async storedBrackets(seasonId: number, region: Region): Promise<Bracket[]> {
    const rows = await this.collection
      .aggregate<{ _id: string }>(
        [
          { $match: { seasonId, region } },
          { $project: { ratings: { $objectToArray: '$ratings' } } },
          { $unwind: '$ratings' },
          { $group: { _id: '$ratings.k' } },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    return rows.map((row) => row._id);
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
