import { Injectable } from '@nestjs/common';

import { BOSSES_COLLECTION } from '../database/collections.js';
import { MongoService } from '../database/mongo.service.js';
import type { RaidDifficulty, RaidRankingRegion } from '../raiderio/raiderio.constants.js';
import type { BossDocument, BossRankedGuild } from './entities/boss.entity.js';

/** A boss as a catalogue walk writes it: no boards. */
export type CataloguedBoss = Pick<
  BossDocument,
  'id' | 'raidId' | 'name' | 'slug' | 'catalogueUpdatedAt'
>;

/** What the rankings job needs to know of a boss's boards to decide what to read. */
export type BossStamps = Pick<BossDocument, 'bossRankingsUpdatedAt' | 'bossRankingsRefusedAt'>;

/**
 * Storage for bosses: one document per boss, its identity written by the
 * catalogue and its boards by the rankings job, field by field, so neither
 * erases the other.
 */
@Injectable()
export class BossRepository {
  constructor(private readonly mongo: MongoService) {}

  private get bosses() {
    return this.mongo.collection<BossDocument>(BOSSES_COLLECTION);
  }

  /** Writes bosses by id. Returns how many were added or changed. */
  async upsertBosses(bosses: readonly CataloguedBoss[]): Promise<number> {
    if (bosses.length === 0) return 0;

    const result = await this.bosses.bulkWrite(
      bosses.map((boss) => ({
        updateOne: { filter: { id: boss.id }, update: { $set: boss }, upsert: true },
      })),
      { ordered: false },
    );

    return result.upsertedCount + result.modifiedCount;
  }

  /** The board stamps of every boss of the given raids, by boss id. */
  async stamps(raidIds: readonly number[]): Promise<Map<number, BossStamps>> {
    const found = await this.bosses
      .find<Pick<BossDocument, 'id'> & BossStamps>(
        { raidId: { $in: [...raidIds] } },
        { projection: { _id: 0, id: 1, bossRankingsUpdatedAt: 1, bossRankingsRefusedAt: 1 } },
      )
      .toArray();

    return new Map(found.map(({ id, ...stamps }) => [id, stamps]));
  }

  /**
   * Replaces one board of one boss and stamps it, clearing any refusal. The
   * identity is set on insert too, so a board read before the catalogue wrote
   * the boss still leaves a whole document.
   */
  async setBoard(
    boss: Omit<CataloguedBoss, 'catalogueUpdatedAt'>,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    guilds: readonly BossRankedGuild[],
    readAt: Date,
  ): Promise<void> {
    await this.bosses.updateOne(
      { id: boss.id },
      {
        $set: {
          [`bossRankings.${region}.${difficulty}`]: guilds,
          [`bossRankingsUpdatedAt.${region}.${difficulty}`]: readAt,
        },
        $unset: { [`bossRankingsRefusedAt.${region}.${difficulty}`]: '' },
        $setOnInsert: {
          raidId: boss.raidId,
          name: boss.name,
          slug: boss.slug,
          catalogueUpdatedAt: readAt,
        },
      },
      { upsert: true },
    );
  }

  /** Records that Raider.io refused one board of a boss. Its stored board is kept. */
  async markRefused(
    bossId: number,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
    refusedAt: Date,
  ): Promise<void> {
    await this.bosses.updateOne(
      { id: bossId },
      { $set: { [`bossRankingsRefusedAt.${region}.${difficulty}`]: refusedAt } },
    );
  }

  findById(id: number): Promise<BossDocument | null> {
    return this.bosses.findOne({ id });
  }
}
