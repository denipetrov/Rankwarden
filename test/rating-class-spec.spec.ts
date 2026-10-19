import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RATING_COLLECTIONS } from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { World } from './support/world.js';

/**
 * Class and spec on rating rows, so a board can be narrowed to one class or
 * one spec. Shuffle and blitz rows know theirs from the ladder name at once;
 * 2v2, 3v3 and rbg rows learn theirs from enrichment.
 */
describe('class and spec on rating rows', () => {
  let harness: TestApp;
  let db: Db;
  let seasonId: number;

  const rows = (family: '3v3' | 'shuffle') => db.collection(RATING_COLLECTIONS[family]);

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us'], players: 80, seed: 17, multiBracketShare: 0.6 }),
    );
    db = harness.app.get(MongoService).db;
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    seasonId = (await rows('shuffle').findOne({}))!.seasonId;
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('labels per-spec rows from the ladder name straight away', async () => {
    const row = await rows('shuffle').findOne({ bracket: /^shuffle-mage-/ });

    expect(row).toMatchObject({ class: 'mage', spec: row!.bracket.split('-')[2] });
    expect(await rows('shuffle').countDocuments({ class: null })).toBe(0);
  });

  it('leaves single-rating rows unlabelled until the character is enriched', async () => {
    expect(await rows('3v3').countDocuments({ class: { $ne: null } })).toBe(0);
    expect(await rows('3v3').countDocuments()).toBeGreaterThan(0);
  });

  it('labels them from the profile once enrichment has run', async () => {
    await harness.app.get(ProfileEnrichmentService).run();

    expect(await rows('3v3').countDocuments({ class: null })).toBe(0);
    await expectInvariants(db);
  });

  it('keeps the labels when the next sweep rewrites the rows', async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();

    expect(await rows('3v3').countDocuments({ class: null })).toBe(0);
    await expectInvariants(db);
  });

  it('serves a board of one class, and of one spec, from the index in rating order', async () => {
    const { class: className, spec } = (await rows('3v3').findOne({}))!;

    const byClass = rows('3v3')
      .find({ seasonId, region: 'us', class: className })
      .sort({ rating: -1 })
      .limit(50);
    const bySpec = rows('3v3')
      .find({ seasonId, region: 'us', class: className, spec })
      .sort({ rating: -1 })
      .limit(50);

    for (const [cursor, index] of [
      [byClass, 'class_board'],
      [bySpec, 'spec_board'],
    ] as const) {
      const plan = await cursor.clone().explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(index);
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('"SORT"');

      const board = await cursor.toArray();
      expect(board.length).toBeGreaterThan(0);
      expect(board.every((row) => row.class === className)).toBe(true);
      expect(board.map((row) => row.rating)).toEqual(
        [...board.map((row) => row.rating)].sort((a, b) => b - a),
      );
    }
  });
});
