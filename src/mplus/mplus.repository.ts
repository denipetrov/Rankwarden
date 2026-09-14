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
} from './entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION, type MplusRunDocument } from './entities/mplus-run.entity.js';

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
      {
        key: { season: 1, region: 1, realmSlug: 1, nameKey: 1 },
        name: 'mplus_character_identity',
        unique: true,
      },
      // The front end's sort: best M+ players in a region.
      { key: { season: 1, region: 1, mythicScore: -1 }, name: 'mplus_score_board' },
      // Cross-region lookup by name, mirroring `character_lookup` on the PvP side.
      { key: { nameKey: 1, realmSlug: 1 }, name: 'mplus_character_lookup' },
      { key: { season: 1, region: 1, updatedAt: 1 }, name: 'mplus_character_freshness' },
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
   * Upserts characters by identity.
   *
   * Whole-document `$set` again, and for a sharper reason than the runs: a
   * character's `dungeonRuns` and `mythicScore` are recomputed from the whole
   * pass, so merging would leave a dungeon they no longer rank in on the
   * document and keep counting its score forever.
   */
  async upsertCharacters(characters: readonly MplusCharacterDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < characters.length; offset += BULK_CHUNK_SIZE) {
      const chunk = characters.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusCharacterDocument>>((character) => ({
        updateOne: {
          filter: {
            season: character.season,
            region: character.region,
            realmSlug: character.realmSlug,
            nameKey: character.nameKey,
          },
          update: { $set: character },
          upsert: true,
        },
      }));

      const result = await this.characters.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Drops runs and characters a completed pass did not refresh — they have
   * fallen off the leaderboard.
   *
   * Only ever called for a region whose pass finished without a shortfall. The
   * guard matters for the same reason `removeRetiredBrackets` refuses an empty
   * bracket list: a pass that failed halfway looks exactly like a leaderboard
   * that lost half its runs, and acting on that empties the region.
   */
  async pruneStale(
    season: string,
    region: RaiderIoRegion,
    before: Date,
  ): Promise<{ runs: number; characters: number }> {
    const runs = await this.runs.deleteMany({ season, region, fetchedAt: { $lt: before } });
    const characters = await this.characters.deleteMany({
      season,
      region,
      updatedAt: { $lt: before },
    });

    return { runs: runs.deletedCount, characters: characters.deletedCount };
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
