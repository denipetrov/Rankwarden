import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AnyBulkWriteOperation, IndexDescription } from 'mongodb';

import { MongoService } from '../database/mongo.service.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import {
  MPLUS_AFFIXES_COLLECTION,
  type MplusAffixDocument,
} from './entities/mplus-affix.entity.js';
import {
  MPLUS_CHARACTERS_COLLECTION,
  type MplusCharacterDocument,
  type MplusCharacterProfile,
  type MplusDungeonRun,
} from './entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION, type MplusRunDocument } from './entities/mplus-run.entity.js';
import { mergeDungeonRuns, scoreOf, withDungeonRuns } from './mplus.mapper.js';

const BULK_CHUNK_SIZE = 1_000;

/**
 * The three Mythic+ collections.
 *
 * One repository rather than three because they are only ever written together,
 * in one pass, and a run's affixes have to be upserted before the run that
 * references them is readable — splitting that across repositories would put
 * the ordering in the service, where it is easier to get wrong.
 */
@Injectable()
export class MplusRepository implements OnModuleInit {
  private readonly logger = new Logger(MplusRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get runs() {
    return this.mongo.collection<MplusRunDocument>(MPLUS_RUNS_COLLECTION);
  }

  private get characters() {
    return this.mongo.collection<MplusCharacterDocument>(MPLUS_CHARACTERS_COLLECTION);
  }

  private get affixes() {
    return this.mongo.collection<MplusAffixDocument>(MPLUS_AFFIXES_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    const runIndexes: IndexDescription[] = [
      { key: { season: 1, region: 1, keystoneRunId: 1 }, name: 'run_identity', unique: true },
      // The headline board: a season's best runs in a region, index-ordered.
      { key: { season: 1, region: 1, score: -1 }, name: 'run_board' },
      // The same board filtered to one dungeon, which is how the UI slices it.
      { key: { season: 1, region: 1, 'dungeon.id': 1, score: -1 }, name: 'run_dungeon_board' },
      // "Every run this character appears in", answered from the flat mirror
      // rather than by scanning nested roster documents.
      { key: { season: 1, region: 1, rosterKeys: 1 }, name: 'run_roster' },
      // Pruning reads this: runs the latest pass did not refresh have fallen
      // off the leaderboard.
      { key: { season: 1, region: 1, fetchedAt: 1 }, name: 'run_freshness' },
    ];

    const characterIndexes: IndexDescription[] = [
      // One canonical key rather than a four-field tuple, so the merge read and
      // the orphan cleanup can both `$in` on it.
      { key: { season: 1, key: 1 }, name: 'mplus_character_identity', unique: true },
      // The front end's sort: best M+ players in a region.
      { key: { season: 1, region: 1, mythicScore: -1 }, name: 'mplus_score_board' },
      // Cross-region lookup by name, mirroring `character_lookup` on the PvP side.
      { key: { nameKey: 1, realmSlug: 1 }, name: 'mplus_character_lookup' },
    ];

    await this.runs.createIndexes(runIndexes);
    await this.characters.createIndexes(characterIndexes);
    await this.affixes.createIndexes([{ key: { id: 1 }, name: 'affix_identity', unique: true }]);

    this.logger.log(
      `Indexes ensured on "${MPLUS_RUNS_COLLECTION}", "${MPLUS_CHARACTERS_COLLECTION}" ` +
        `and "${MPLUS_AFFIXES_COLLECTION}"`,
    );
  }

  /** Upserts the affixes seen in a batch of runs. Cheap: there are three a week. */
  async upsertAffixes(affixes: readonly MplusAffixDocument[]): Promise<number> {
    if (affixes.length === 0) return 0;

    const result = await this.affixes.bulkWrite(
      affixes.map((affix) => ({
        updateOne: {
          filter: { id: affix.id },
          update: { $set: affix },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    return result.upsertedCount + result.modifiedCount;
  }

  /**
   * Upserts runs by identity.
   *
   * A run is immutable once completed, so this is `$set` of the whole document
   * rather than a merge: re-reading the same run writes the same values, plus a
   * fresh `fetchedAt` — which is the point, since `fetchedAt` is what pruning
   * distinguishes a still-ranked run by.
   */
  async upsertRuns(runs: readonly MplusRunDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < runs.length; offset += BULK_CHUNK_SIZE) {
      const chunk = runs.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusRunDocument>>((run) => ({
        updateOne: {
          filter: { season: run.season, region: run.region, keystoneRunId: run.keystoneRunId },
          update: { $set: run },
          upsert: true,
        },
      }));

      const result = await this.runs.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Upserts characters, keeping each dungeon's best run across passes.
   *
   * Read-merge-write rather than a blind `$set`, because `mythicScore` must not
   * fall (see `MplusCharacterDocument`). The stored `dungeonRuns` are merged
   * with the freshly computed ones by `mergeDungeonRuns`, and the score and
   * coverage are re-derived from the result — so the document always adds up,
   * whichever half each dungeon's entry came from.
   *
   * Everything *else* on the document is still overwritten wholesale: name,
   * realm, faction and profile are facts about the character now, and a rename
   * or a respec should follow along rather than being merged into the past.
   *
   * The read is chunked alongside the write rather than done once per region,
   * so memory stays bounded by `BULK_CHUNK_SIZE` instead of by the size of the
   * ladder, and it is a covered `$in` on the identity index.
   */
  async upsertCharacters(
    characters: readonly MplusCharacterDocument[],
  ): Promise<{ written: number; merged: number }> {
    let written = 0;
    let merged = 0;

    for (let offset = 0; offset < characters.length; offset += BULK_CHUNK_SIZE) {
      const chunk = characters.slice(offset, offset + BULK_CHUNK_SIZE);
      const stored = await this.storedRunsFor(chunk);

      const operations = chunk.map<AnyBulkWriteOperation<MplusCharacterDocument>>((character) => {
        const previous = stored.get(character.key);
        const dungeonRuns = previous
          ? mergeDungeonRuns(previous, character.dungeonRuns)
          : character.dungeonRuns;

        if (previous && dungeonRuns.length > character.dungeonRuns.length) merged += 1;

        return {
          updateOne: {
            filter: { season: character.season, key: character.key },
            update: { $set: withDungeonRuns(character, dungeonRuns) },
            upsert: true,
          },
        };
      });

      const result = await this.characters.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return { written, merged };
  }

  /**
   * Updates one existing character from the sync endpoint. Never inserts.
   *
   * Never inserting is the same rule the PvP sync follows: a character absent
   * here is one no leaderboard lists, and creating one would fill the collection
   * with players the boards do not rank.
   *
   * `dungeonRuns` is **merged, not authoritative** — the opposite of the PvP
   * endpoint's `brackets`, and deliberately so. Monotonicity is a property of
   * the data rather than of one code path, so a push cannot lower a score that a
   * pass would have held. The consequence a caller has to know: sending fewer
   * runs does not remove the others, and an empty array is a profile-only update
   * rather than "this character has no runs".
   *
   * `fields` is applied wholesale and `profile` field by field, so a caller that
   * knows a character's realm cannot blank their spec by omitting it.
   */
  async syncCharacter(
    season: string,
    key: string,
    fields: Partial<MplusCharacterDocument>,
    profile: Partial<MplusCharacterProfile>,
    incoming: readonly MplusDungeonRun[],
  ): Promise<{ matched: boolean; mythicScore: number; dungeonsCovered: number; added: number }> {
    const existing = await this.characters.findOne(
      { season, key },
      { projection: { dungeonRuns: 1 } },
    );

    if (!existing) return { matched: false, mythicScore: 0, dungeonsCovered: 0, added: 0 };

    const stored = existing.dungeonRuns ?? [];
    const dungeonRuns = mergeDungeonRuns(stored, incoming);
    const update: Record<string, unknown> = { ...fields };

    for (const [name, value] of Object.entries(profile)) {
      if (value !== undefined) update[`profile.${name}`] = value;
    }

    // Re-derived rather than trusted from the caller, the only way the three
    // cannot drift apart.
    update.dungeonRuns = dungeonRuns;
    update.mythicScore = scoreOf(dungeonRuns);
    update.dungeonsCovered = dungeonRuns.length;

    await this.characters.updateOne({ season, key }, { $set: update });

    return {
      matched: true,
      mythicScore: update.mythicScore as number,
      dungeonsCovered: dungeonRuns.length,
      added: dungeonRuns.length - stored.length,
    };
  }

  /** The `dungeonRuns` already stored for a chunk, keyed by identity. */
  private async storedRunsFor(
    chunk: readonly MplusCharacterDocument[],
  ): Promise<Map<string, MplusDungeonRun[]>> {
    const rows = await this.characters
      .find(
        { season: chunk[0].season, key: { $in: chunk.map((character) => character.key) } },
        { projection: { key: 1, dungeonRuns: 1 } },
      )
      .toArray();

    return new Map(rows.map((row) => [row.key, row.dungeonRuns ?? []]));
  }

  /**
   * Removes what has fallen off the leaderboard, in two stages and in this order.
   *
   * | # | Stage                          | Removes                                  |
   * | - | ------------------------------ | ---------------------------------------- |
   * | 1 | runs this pass did not refresh | a run pushed out of the top 20,020       |
   * | 2 | characters left in no run      | a player whose every run has fallen off  |
   *
   * **The order is load-bearing**, the same way steps 3-5 of the PvP sweep
   * cleanup are: stage 2 asks which characters no surviving run lists, so it has
   * to run *after* the runs are gone or every character still looks current.
   *
   * Stage 2 is a referential check rather than a timestamp check, and that is
   * the point. Now that a character keeps each dungeon's best run once earned,
   * "not seen this pass" no longer means "gone" — a character can be absent from
   * a pass and still hold a legitimate score. Only having no run at all on the
   * board does mean gone.
   *
   * Only ever called for a region whose pass finished cleanly. Both stages also
   * carry their own guard below, because the cost of being wrong is emptying a
   * region and refilling it next pass with a hole in the board each time.
   */
  async pruneStale(
    season: string,
    region: RaiderIoRegion,
    before: Date,
  ): Promise<{ runs: number; characters: number }> {
    const runs = await this.pruneStaleRuns(season, region, before);
    const characters = await this.removeCharactersWithoutRuns(season, region);

    return { runs, characters };
  }

  /** Stage 1: runs the latest pass did not refresh. */
  async pruneStaleRuns(season: string, region: RaiderIoRegion, before: Date): Promise<number> {
    const removed = await this.runs.deleteMany({ season, region, fetchedAt: { $lt: before } });

    return removed.deletedCount;
  }

  /**
   * Stage 2: characters no surviving run lists.
   *
   * The Mythic+ counterpart to `RatingRepository.removeOrphans`, and computed
   * the same way — read both key sets, difference them, delete in chunks —
   * rather than with a `$nin` of thirty thousand keys or a `$lookup` per
   * document.
   */
  async removeCharactersWithoutRuns(season: string, region: RaiderIoRegion): Promise<number> {
    const live = await this.liveRosterKeys(season, region);

    // No runs at all means the pass failed for this region, not that every
    // player left the ladder. Without this guard one bad region is wiped — the
    // same trap `removeRetiredBrackets` refuses an empty bracket list for.
    if (live.size === 0) return 0;

    const stored = await this.characters
      .find({ season, region }, { projection: { key: 1 } })
      .toArray();
    const orphans = stored.map((row) => row.key).filter((key) => !live.has(key));

    let removed = 0;

    for (let offset = 0; offset < orphans.length; offset += BULK_CHUNK_SIZE) {
      const chunk = orphans.slice(offset, offset + BULK_CHUNK_SIZE);
      const result = await this.characters.deleteMany({ season, key: { $in: chunk } });
      removed += result.deletedCount;
    }

    if (removed > 0) {
      this.logger.log(`Removed ${removed} Mythic+ character(s) left in no run in ${region}`);
    }

    return removed;
  }

  /**
   * Every character key still named by a run in the region.
   *
   * Aggregated rather than `distinct`, which caps its reply at 16MB: a region is
   * up to 20,020 runs x 5 members, and while the deduplicated set fits today it
   * is not far enough under the cap to rely on.
   */
  private async liveRosterKeys(season: string, region: RaiderIoRegion): Promise<Set<string>> {
    const rows = await this.runs
      .aggregate<{ _id: string }>(
        [
          { $match: { season, region } },
          { $unwind: '$rosterKeys' },
          { $group: { _id: '$rosterKeys' } },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    return new Set(rows.map((row) => row._id));
  }

  /**
   * Removes every trace of a season that is no longer current.
   *
   * The M+ counterpart to the PvP season purge, but far simpler: M+ data is a
   * leaderboard snapshot rather than standings anyone archives, and it is
   * rebuilt in full on every pass, so a superseded season is just stale.
   */
  async purgeSeason(season: string): Promise<{ runs: number; characters: number }> {
    const runs = await this.runs.deleteMany({ season });
    const characters = await this.characters.deleteMany({ season });

    return { runs: runs.deletedCount, characters: characters.deletedCount };
  }

  /** Season slugs with any data stored, so a rollover can clear the old one. */
  storedSeasons(): Promise<string[]> {
    return this.runs.distinct('season');
  }

  countRuns(season: string, region?: RaiderIoRegion): Promise<number> {
    return this.runs.countDocuments(region ? { season, region } : { season });
  }

  countCharacters(season: string, region?: RaiderIoRegion): Promise<number> {
    return this.characters.countDocuments(region ? { season, region } : { season });
  }
}
