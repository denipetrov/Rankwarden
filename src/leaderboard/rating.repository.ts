import { Injectable, Logger } from '@nestjs/common';
import type { AnyBulkWriteOperation, Collection } from 'mongodb';

import {
  classSpecOfBracket,
  CORE_BRACKETS,
  ratingFamilyOf,
  RATING_FAMILIES,
  specSplitFamilyOf,
  type Bracket,
  type Region,
  type RatingFamily,
} from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';
import { toSlug } from '../representation/entities/spec-representation.entity.js';
import type { CharacterDocument } from './entities/character.entity.js';
import { type RatingDocument } from './entities/rating.entity.js';
import { CHARACTERS_COLLECTION, RATING_COLLECTIONS } from '../database/collections.js';

const BULK_CHUNK_SIZE = 1_000;

/** A rating row's class and spec, as slugs; spec null when only the class is known. */
type ClassSpec = { class: string; spec: string | null };

/**
 * Flat rating rows, one collection per ladder family.
 *
 * One row per rating rather than one document per player: 2v2, 3v3 and rbg give
 * a character a single row each, while shuffle and blitz give them one per spec
 * they have played. Every board is then a sorted range scan over one collection,
 * with display data joined from `characters` afterwards.
 */
@Injectable()
export class RatingRepository {
  private readonly logger = new Logger(RatingRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private collection(family: RatingFamily): Collection<RatingDocument> {
    return this.mongo.collection<RatingDocument>(RATING_COLLECTIONS[family]);
  }

  /**
   * Mirrors one bracket's leaderboard into its family's collection.
   *
   * Each row is labelled with its class and spec. A per-spec ladder names them;
   * a single-rating ladder does not, so they are read from the characters'
   * enriched profiles — one query per chunk. A character not yet enriched gets
   * null on a new row and keeps whatever an existing row already says;
   * `labelFromProfile` fills it in once enrichment has run.
   */
  async upsertBracket(
    family: RatingFamily,
    updates: readonly CharacterBracketUpdate[],
  ): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < updates.length; offset += BULK_CHUNK_SIZE) {
      const chunk = updates.slice(offset, offset + BULK_CHUNK_SIZE);
      const fromProfiles = specSplitFamilyOf(chunk[0]?.bracket ?? '')
        ? new Map<number, ClassSpec>()
        : await this.profileLabels(chunk);

      const operations = chunk.map<AnyBulkWriteOperation<RatingDocument>>((update) => {
        const label = classSpecOfBracket(update.bracket) ?? fromProfiles.get(update.characterId);

        return {
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
                ...(label ? { class: label.class, spec: label.spec } : {}),
              },
              $setOnInsert: {
                seasonId: update.seasonId,
                region: update.region,
                bracket: update.bracket,
                characterId: update.characterId,
                ...(label ? {} : { class: null, spec: null }),
              },
            },
            upsert: true,
          },
        };
      });

      const result = await this.collection(family).bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Labels a character's 2v2, 3v3 and rbg rows with the class and spec of their
   * enriched profile. Called after enrichment writes a profile, so a respec or
   * a first enrichment reaches the boards without waiting for anything else.
   * Shuffle and blitz rows are left alone: their bracket already names both.
   */
  async labelFromProfile(seasonId: number, region: Region, characterId: number): Promise<void> {
    const [label] = (await this.profileLabels([{ seasonId, region, characterId }])).values();
    if (!label) return;

    for (const family of CORE_BRACKETS) {
      await this.collection(family).updateMany(
        { seasonId, region, characterId },
        { $set: { class: label.class, spec: label.spec } },
      );
    }
  }

  /**
   * The class and spec slugs of each character's enriched profile, for the
   * characters that have one. Keyed by character id; all of `characters` must
   * share one season and region, as a bracket's rows always do.
   */
  private async profileLabels(
    characters: readonly { seasonId: number; region: Region; characterId: number }[],
  ): Promise<Map<number, ClassSpec>> {
    const first = characters[0];
    if (!first) return new Map();

    const documents = await this.mongo
      .collection<CharacterDocument>(CHARACTERS_COLLECTION)
      .find(
        {
          seasonId: first.seasonId,
          region: first.region,
          characterId: { $in: characters.map((character) => character.characterId) },
          'profile.class.name': { $exists: true },
        },
        { projection: { _id: 0, characterId: 1, 'profile.class': 1, 'profile.spec': 1 } },
      )
      .toArray();

    return new Map(
      documents.map((document) => [
        document.characterId,
        {
          class: toSlug(document.profile!.class.name),
          spec: document.profile!.spec ? toSlug(document.profile!.spec.name) : null,
        },
      ]),
    );
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
   * Deletes every row of the characters named: the ones a sweep has just
   * removed for ranking in nothing.
   *
   * The everyday form of orphan removal. It reads nothing and touches only the
   * rows of those characters, through the `character` index, so its cost
   * follows the handful of characters that left rather than the size of the
   * region.
   */
  async removeForCharacters(
    seasonId: number,
    region: Region,
    characterIds: readonly number[],
  ): Promise<number> {
    let removed = 0;

    for (let offset = 0; offset < characterIds.length; offset += BULK_CHUNK_SIZE) {
      const chunk = characterIds.slice(offset, offset + BULK_CHUNK_SIZE);

      for (const family of RATING_FAMILIES) {
        const result = await this.collection(family).deleteMany({
          seasonId,
          region,
          characterId: { $in: chunk },
        });
        removed += result.deletedCount;
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Removed ${removed} rating rows of ${characterIds.length} unranked character(s) in ${region}`,
      );
    }

    return removed;
  }

  /**
   * Deletes rows belonging to characters that no longer exist.
   *
   * Per-bracket pruning already removes a row when a character leaves that
   * ladder, but it can only act on brackets the sweep actually visited. A
   * character deleted outright, or one whose bracket Blizzard stopped
   * publishing, would leave rows behind that no board should ever show. This
   * reconciles against `characters`, which is the record of who exists.
   *
   * The full reconciliation, and expensive: it reads every character id and
   * every rated character id in the region to compare them. A sweep runs it
   * only when it cannot vouch for the previous cleanup (see
   * `LeaderboardService`); otherwise `removeForCharacters` does the same job
   * from the list of who was just removed.
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
