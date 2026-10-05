import { Injectable } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import type { RaidDifficulty, RaidRankingRegion } from '../raiderio/raiderio.constants.js';
import {
  RAIDS_COLLECTION,
  type RaidDocument,
  type RaidEncounter,
  type RaidRankedGuild,
} from './entities/raid.entity.js';

/** What the rankings job needs to know about a raid to decide what to read. */
export interface RaidRankingTarget {
  id: number;
  slug: string;
  ends: RaidDocument['ends'];
  encounters: RaidEncounter[];
  guildsUpdatedAt?: RaidDocument['guildsUpdatedAt'];
  guildsRefusedAt?: RaidDocument['guildsRefusedAt'];
}

const TARGET_FIELDS = {
  projection: {
    _id: 0,
    id: 1,
    slug: 1,
    ends: 1,
    encounters: 1,
    guildsUpdatedAt: 1,
    guildsRefusedAt: 1,
  },
} as const;

/**
 * The boards stored on raid documents. The same collection the catalogue
 * writes, a different set of fields — which is why the catalogue's writes are
 * field-level.
 */
@Injectable()
export class RaidRankingsRepository {
  constructor(private readonly mongo: MongoService) {}

  private get raids() {
    return this.mongo.collection<RaidDocument>(RAIDS_COLLECTION);
  }

  /**
   * Every raid still listed, newest first, without its boards: the job reads
   * all of them every tick, and the boards are the bulk of a raid document.
   */
  targets(): Promise<RaidRankingTarget[]> {
    return this.raids
      .find<RaidRankingTarget>({ unlistedAt: { $exists: false } }, TARGET_FIELDS)
      .sort({ expansionId: -1, id: -1 })
      .toArray();
  }

  /** One raid still listed, by slug. */
  target(slug: string): Promise<RaidRankingTarget | null> {
    return this.raids.findOne<RaidRankingTarget>(
      { slug, unlistedAt: { $exists: false } },
      TARGET_FIELDS,
    );
  }

  /**
   * Records that Raider.io refused one board. The board itself, if one was
   * ever stored, is left as it was.
   */
  async markRefused(
    raidId: number,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    refusedAt: Date,
  ): Promise<void> {
    await this.raids.updateOne(
      { id: raidId },
      { $set: { [`guildsRefusedAt.${region}.${difficulty}`]: refusedAt } },
    );
  }

  /**
   * Replaces one board of one raid and stamps it, clearing any refusal. Only
   * that board: the others, and everything the catalogue wrote, are left as
   * they are.
   */
  async setBoard(
    raidId: number,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    guilds: readonly RaidRankedGuild[],
    readAt: Date,
  ): Promise<void> {
    await this.raids.updateOne(
      { id: raidId },
      {
        $set: {
          [`guilds.${region}.${difficulty}`]: guilds,
          [`guildsUpdatedAt.${region}.${difficulty}`]: readAt,
        },
        $unset: { [`guildsRefusedAt.${region}.${difficulty}`]: '' },
      },
    );
  }
}
