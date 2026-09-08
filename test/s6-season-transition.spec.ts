import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import {
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import {
  SEASON_STATE_COLLECTION,
  SEASON_TRANSITIONS_COLLECTION,
} from '../src/season/entities/season-state.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SeasonTransitionService } from '../src/season/season-transition.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World } from './support/world.js';

/**
 * S6 — season end and rollover at runtime, and the retention contract.
 *
 * A finished season stays live until the next one actually begins; the gate is
 * the earliest new-season start across regions, and the delete is scoped per
 * region so a trailing region keeps its own live board.
 */
describe('S6 — season transition', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    SEASON_PURGE_DRY_RUN: 'false',
    SEASON_PURGE_REQUIRE_ARCHIVE: 'true',
  };

  const SEASON = 42;
  const NEXT = 43;

  let harness: TestApp;
  let db: Db;
  let transitions: SeasonTransitionService;

  const characters = () => db.collection(CHARACTERS_COLLECTION);

  /**
   * Gives a region's players ratings again after a rollover.
   *
   * `World.rollover` clears every ladder in the region, which is what really
   * happens on day one of a season — so without this the new season is empty
   * and there is nothing to assert about it coexisting with the old one.
   */
  const repopulate = (region: 'us' | 'eu') => {
    const players = [...harness.world.players.values()].filter(
      (player) => player.region === region,
    );
    for (const [index, player] of players.entries()) {
      harness.world.setRating(player.id, index % 2 === 0 ? '3v3' : '2v2', 1800 + index);
    }
  };
  const sweep = async () => {
    const result = await harness.app.get(LeaderboardService).sweep();
    expect(result, 'sweep must not be skipped').not.toBeNull();
  };

  /** Marks a season fully archived, which the purge interlock requires. */
  const markArchived = async (seasonId: number, region: string) => {
    await db.collection(ARCHIVE_SEASONS_COLLECTION).updateOne(
      { seasonId, region },
      {
        $set: { failedBrackets: [], brackets: 83, entries: 1, archivedAt: new Date() },
        $setOnInsert: { seasonId, region },
      },
      { upsert: true },
    );
  };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 60, seed: 6, season: SEASON }),
      ENV,
    );
    db = harness.app.get(MongoService).db;
    transitions = harness.app.get(SeasonTransitionService);
    await harness.settle();
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S6.1 — a season ending is detected on a running process', async () => {
    const endsAt = new Date('2026-08-11T05:00:00.000Z');
    harness.world.endSeason('us', endsAt);

    await harness.app.get(SeasonService).refresh('us');

    const seasons = harness.app.get(SeasonService);
    expect(seasons.hasEnded('us')).toBe(true);
    expect(seasons.describe().us.endsAt).toBe(endsAt.toISOString());
    // eu is untouched: seasons end per region.
    expect(seasons.hasEnded('eu')).toBe(false);

    const state = await db.collection(SEASON_STATE_COLLECTION).findOne({ region: 'us' });
    expect(state!.endsAt).toEqual(endsAt);
  });

  it('S6.2 — an ended season is not re-read', async () => {
    harness.blizzard.reset();
    await harness.app.get(SeasonService).refresh('us');
    await harness.app.get(SeasonService).refresh('us');

    // The index is still read; the season record itself is settled forever.
    expect(harness.blizzard.countMatching(`pvp-season/${SEASON}`)).toBe(0);
  });

  it('S6.16 — a finished season with no successor is not purged', async () => {
    await markArchived(SEASON, 'us');
    await markArchived(SEASON, 'eu');

    const before = await characters().countDocuments();
    const plan = await transitions.plan();

    // The gate is the *next* season starting. Ending is not enough.
    expect(plan.newestSeason).toBe(SEASON);
    expect(plan.candidates).toEqual([]);

    const outcome = await transitions.run();
    expect(outcome.purged).toEqual([]);
    expect(await characters().countDocuments()).toBe(before);
  });

  it('S6.24 — a partial view of the regions abstains entirely', async () => {
    await db.collection(SEASON_STATE_COLLECTION).deleteOne({ region: 'eu' });

    const plan = await transitions.plan();

    expect(plan.permitted).toBe(false);
    expect(plan.reason).toMatch(/eu/);
    expect(plan.candidates).toEqual([]);

    // Restore for the cases that follow.
    await harness.app.get(SeasonService).refresh('eu');
    expect(await db.collection(SEASON_STATE_COLLECTION).countDocuments()).toBe(2);
  });

  describe('after us rolls over and eu has not', () => {
    const usStart = new Date('2026-08-18T15:00:00.000Z');

    beforeAll(async () => {
      harness.world.rollover('us', NEXT, usStart);
      repopulate('us');
      await harness.app.get(SeasonService).refresh('us');
      await sweep();
    });

    it('S6.5 — writes the new season alongside the old', async () => {
      const oldSeason = await characters().countDocuments({ region: 'us', seasonId: SEASON });
      const newSeason = await characters().countDocuments({ region: 'us', seasonId: NEXT });

      expect(oldSeason, 'season 42 is retained until the gate opens').toBeGreaterThan(0);
      expect(newSeason, 'the new season is being ingested').toBeGreaterThan(0);
    });

    it('S6.17 — the gate opens at the earliest region start', async () => {
      const plan = await transitions.plan();

      expect(plan.newestSeason).toBe(NEXT);
      expect(plan.transitionAt).toBe(usStart.toISOString());
      expect(plan.permitted).toBe(true);

      // A moment before that start, the gate is shut.
      const early = await transitions.plan(new Date(usStart.getTime() - 60_000));
      expect(early.permitted).toBe(false);
      expect(early.reason).toMatch(/starts at/);
    });

    it('S6.22 — a season the archive does not hold in full is blocked', async () => {
      await db
        .collection(ARCHIVE_SEASONS_COLLECTION)
        .updateOne({ seasonId: SEASON, region: 'us' }, { $set: { failedBrackets: ['3v3'] } });

      const plan = await transitions.plan();

      expect(
        plan.candidates.find((c) => c.region === 'us' && c.seasonId === SEASON),
      ).toBeUndefined();
      expect(
        plan.blockedByArchive.find((c) => c.region === 'us' && c.seasonId === SEASON),
      ).toBeDefined();

      const outcome = await transitions.run();
      expect(outcome.purged).toEqual([]);
      expect(await characters().countDocuments({ region: 'us', seasonId: SEASON })).toBeGreaterThan(
        0,
      );

      await markArchived(SEASON, 'us');
    });

    it('S6.18 / S6.19 — purges us season 42 and leaves eu untouched', async () => {
      const euBefore = await characters().countDocuments({ region: 'eu', seasonId: SEASON });
      const usNewBefore = await characters().countDocuments({ region: 'us', seasonId: NEXT });
      expect(euBefore, 'eu is still playing season 42').toBeGreaterThan(0);

      await db.collection(ARCHIVE_ENTRIES_COLLECTION).insertOne({
        seasonId: SEASON,
        region: 'us',
        bracket: '3v3',
        characterId: 1,
        characterName: 'Archived',
        realmId: 60,
        realmSlug: 'tarren-mill',
        faction: 'HORDE',
        rank: 1,
        rating: 3000,
        played: 1,
        won: 1,
        lost: 0,
      });

      const outcome = await transitions.run();

      const purgedUs = outcome.purged.find((p) => p.region === 'us' && p.seasonId === SEASON);
      expect(purgedUs, 'us season 42 must be retired').toBeDefined();
      expect(purgedUs!.dryRun).toBe(false);

      expect(await characters().countDocuments({ region: 'us', seasonId: SEASON })).toBe(0);
      expect(
        await db.collection(RATING_COLLECTIONS['3v3']).countDocuments({
          region: 'us',
          seasonId: SEASON,
        }),
      ).toBe(0);
      expect(
        await db
          .collection(SPEC_REPRESENTATION_COLLECTION)
          .countDocuments({ region: 'us', seasonId: SEASON }),
      ).toBe(0);

      // The trailing region keeps its live board, and the new season is intact.
      expect(await characters().countDocuments({ region: 'eu', seasonId: SEASON })).toBe(euBefore);
      expect(await characters().countDocuments({ region: 'us', seasonId: NEXT })).toBe(usNewBefore);

      // I10 — the archive is untouched by any of it.
      expect(
        await db
          .collection(ARCHIVE_ENTRIES_COLLECTION)
          .countDocuments({ seasonId: SEASON, region: 'us' }),
      ).toBe(1);
    });

    it('S6.20 — purging is idempotent', async () => {
      const record = await db
        .collection(SEASON_TRANSITIONS_COLLECTION)
        .countDocuments({ seasonId: SEASON, region: 'us' });
      expect(record).toBe(1);

      const again = await transitions.run();
      expect(again.purged.find((p) => p.region === 'us' && p.seasonId === SEASON)).toBeUndefined();
      expect(
        await db
          .collection(SEASON_TRANSITIONS_COLLECTION)
          .countDocuments({ seasonId: SEASON, region: 'us' }),
      ).toBe(1);
    });

    it('S6.19b — eu retires its own season only once it rolls over', async () => {
      const euStart = new Date(usStart.getTime() + 26 * 3_600_000);
      harness.world.rollover('eu', NEXT, euStart);
      repopulate('eu');
      await harness.app.get(SeasonService).refresh('eu');
      await sweep();

      await markArchived(SEASON, 'eu');
      const outcome = await transitions.run(new Date(euStart.getTime() + 1000));

      expect(outcome.purged.find((p) => p.region === 'eu' && p.seasonId === SEASON)).toBeDefined();
      expect(await characters().countDocuments({ region: 'eu', seasonId: SEASON })).toBe(0);
      expect(await characters().countDocuments({ seasonId: NEXT })).toBeGreaterThan(0);
    });
  });
});
