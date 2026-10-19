import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { SEASON_STATE_COLLECTION } from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import type { SeasonStateDocument } from '../src/season/entities/season-state.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World } from './support/world.js';

const SEASON = 42;
const NEXT = 43;

/**
 * The current season's titles and cutoffs on `season_state`, read after every
 * sweep so a reader can show who would earn a title if the season ended now.
 *
 * The expectation is taken from what the fake served, not from the mapping
 * under test, so a mapping that is consistently wrong still fails here; the
 * mapping itself has its own cases next to the archive's rewards.
 */
describe('current-season rewards', () => {
  let harness: TestApp;
  let db: Db;

  const state = (region: 'us' | 'eu') =>
    db.collection<SeasonStateDocument>(SEASON_STATE_COLLECTION).findOne({ region });

  /** A sweep, then whatever it set off, so the rewards read has finished. */
  const sweep = async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();
  };

  /** The 3v3 cutoff the fake serves for a season — what the stored entry must say. */
  const served3v3Cutoff = (region: 'us' | 'eu', seasonId: number) => {
    const payload = harness.world.rewardsPayload(region, seasonId)!.rewards as {
      bracket: { type: string };
      rating_cutoff: number;
    }[];

    return payload.find((reward) => reward.bracket.type === 'ARENA_3v3')!.rating_cutoff;
  };

  const rewardRequests = (seasonId: number) =>
    harness.blizzard.countMatching(`pvp-season/${seasonId}/pvp-reward/index`);

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 60, seed: 11, season: SEASON }),
      { SEASON_REWARDS_ENABLED: 'true' },
    );
    db = harness.app.get(MongoService).db;
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  beforeEach(() => {
    harness.world.clearFaults();
    harness.blizzard.reset();
  });

  it('stores every title of the current season after a sweep', async () => {
    for (const region of ['us', 'eu'] as const) {
      const stored = await state(region);
      const served = harness.world.rewardsPayload(region, SEASON)!.rewards;

      expect(stored!.seasonId).toBe(SEASON);
      expect(stored!.rewardsFetchedAt).toBeInstanceOf(Date);
      expect(stored!.rewards, 'every served reward is placed on a ladder').toHaveLength(
        served.length,
      );
      expect(stored!.rewards!.find((reward) => reward.bracket === '3v3')).toMatchObject({
        ratingCutoff: served3v3Cutoff(region, SEASON),
        faction: null,
      });
      // Faction-split titles keep their side, as the archive's do.
      expect(
        stored!.rewards!.filter((reward) => reward.bracket === 'rbg').map((r) => r.faction),
      ).toEqual(['ALLIANCE', 'HORDE']);
    }
  });

  it('re-reads the cutoffs on every sweep, one request per region', async () => {
    const before = (await state('us'))!.rewardsFetchedAt!;

    await sweep();

    expect(rewardRequests(SEASON), 'us and eu, once each').toBe(2);
    expect((await state('us'))!.rewardsFetchedAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it('keeps the last cutoffs when a read fails, and still updates the other region', async () => {
    const usBefore = await state('us');
    const euBefore = await state('eu');
    harness.world.fail('us', 'rewards', 503);

    await sweep();

    const usAfter = await state('us');
    expect(usAfter!.rewards).toEqual(usBefore!.rewards);
    expect(usAfter!.rewardsFetchedAt).toEqual(usBefore!.rewardsFetchedAt);
    expect((await state('eu'))!.rewardsFetchedAt!.getTime()).toBeGreaterThan(
      euBefore!.rewardsFetchedAt!.getTime(),
    );
  });

  it('never shows the old season under the new one', async () => {
    // The new season's cutoffs are not served yet, as in its first hours.
    harness.world.rollover('us', NEXT, new Date('2026-09-02T15:00:00.000Z'));
    harness.world.fail('us', 'rewards', 404);

    await sweep();

    const rolled = await state('us');
    expect(rolled!.seasonId).toBe(NEXT);
    expect(rolled!.rewards, 'the old season’s cutoffs are gone').toBeUndefined();
    expect(rolled!.rewardsFetchedAt).toBeUndefined();
    // Europe is still on the old season and keeps its cutoffs.
    expect((await state('eu'))!.rewards!.length).toBeGreaterThan(0);
  });

  it('fills the new season in once Blizzard serves its cutoffs', async () => {
    await sweep();

    const stored = await state('us');
    expect(stored!.seasonId).toBe(NEXT);
    expect(stored!.rewards!.find((reward) => reward.bracket === '3v3')!.ratingCutoff).toBe(
      served3v3Cutoff('us', NEXT),
    );
    expect(served3v3Cutoff('us', NEXT), 'the two seasons differ').not.toBe(
      served3v3Cutoff('us', SEASON),
    );
  });
});
