import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectNoUnrankedCharacters } from './support/invariants.js';
import { CORE_BRACKETS, World } from './support/world.js';

/**
 * S7.16 / S7.17 — converging from a half-written state.
 *
 * A process killed mid-sweep leaves some brackets written and the cleanup pass
 * never run, so the database holds a mixture of fresh and stale rows with no
 * marker saying which is which. The recovery mechanism is the `fetchedAt` on
 * each bracket: the next sweep rewrites what is still ranked and prunes what
 * carries an older stamp.
 *
 * The abort is reproduced by writing that half-finished state rather than by
 * killing a process mid-flight, which cannot be done at a defined point.
 */
describe('S7 — recovering from an interrupted run', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    PROFILE_REQUESTS_PER_SECOND: '2000',
  };

  let harness: TestApp;
  let db: Db;
  let dbName: string;
  let world: World;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const sweep = async () => {
    const result = await harness.app.get(LeaderboardService).sweep();
    expect(result, 'sweep must not be skipped').not.toBeNull();
    await harness.settle();

    return result!;
  };

  const restart = async () => {
    await harness.close();
    harness = await bootTestApp(world, { ...ENV, MONGODB_DB: dbName });
    db = harness.app.get(MongoService).db;
    await harness.settle();
  };

  beforeAll(async () => {
    world = World.seed({
      regions: ['us'],
      players: 60,
      seed: 716,
      brackets: [...CORE_BRACKETS],
      multiBracketShare: 1,
    });
    for (const player of world.players.values()) {
      for (const [index, bracket] of CORE_BRACKETS.entries()) {
        world.setRating(player.id, bracket, 1600 + index * 30 + (player.id % 200));
      }
    }

    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    dbName = harness.dbName;
    await harness.settle();
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S7.16 — the next sweep repairs what an aborted one left behind', async () => {
    const stale = new Date(Date.now() - 3 * 3_600_000);
    const gone = [...world.players.values()].slice(0, 15);

    // The state an abort leaves: 2v2 was written and then the process died, so
    // every other bracket still carries the previous run's older stamp, and the
    // cleanup that would have pruned them never ran. Fifteen players have since
    // left rbg, and nothing has noticed.
    await characters().updateMany({ region: 'us' }, { $set: { 'brackets.rbg.fetchedAt': stale } });
    for (const player of gone) world.dropFromBracket(player.id, 'rbg');

    const before = await characters().countDocuments({
      region: 'us',
      'brackets.rbg': { $exists: true },
    });
    expect(before, 'the stale rbg keys are still there before the repair').toBe(world.players.size);

    const result = await sweep();

    expect(result.failed).toBe(0);
    expect(
      await characters().countDocuments({ region: 'us', 'brackets.rbg': { $exists: true } }),
      'the fifteen who left are pruned by their older fetchedAt',
    ).toBe(world.players.size - gone.length);

    for (const player of gone) {
      const stored = await characters().findOne({ region: 'us', characterId: player.id });
      expect(stored!.brackets.rbg, `${player.name} no longer holds an rbg key`).toBeUndefined();
      expect(stored!.ratings.rbg, 'and the mirror follows').toBeUndefined();
      expect(
        await db
          .collection(RATING_COLLECTIONS.rbg)
          .countDocuments({ region: 'us', characterId: player.id }),
        'nor a flat row',
      ).toBe(0);
    }

    // No document is left holding a bracket the ladder no longer contains.
    await expectInvariants(db, world);
    await expectNoUnrankedCharacters(db);
  });

  it('S7.17 — a restart between a sweep and its enrichment loses no newcomers', async () => {
    // Everyone enriched, so the newcomers below are the only ones due.
    await harness.app.get(ProfileEnrichmentService).run();
    expect(await characters().countDocuments({ profileFetchedAt: { $exists: false } })).toBe(0);

    const added = world.addPlayers(20, { region: 'us', brackets: ['3v3'] });
    await sweep();

    // Enrichment is disabled in this file, so the sweep's `completed$` reaches
    // nobody — exactly what a process killed right after the sweep leaves.
    const pending = await characters().countDocuments({ profileFetchedAt: { $exists: false } });
    expect(pending, 'the newcomers are stored but unenriched').toBe(added.length);

    await restart();

    // The event is an optimisation; the mechanism is the absent timestamp,
    // which survives the process and sorts ahead of every date.
    const pass = await harness.app.get(ProfileEnrichmentService).run();

    expect(pass!.selected).toBeGreaterThanOrEqual(added.length);
    expect(
      await characters().countDocuments({ profileFetchedAt: { $exists: false } }),
      'every newcomer was picked up by the first pass after the restart',
    ).toBe(0);

    for (const player of added) {
      const stored = await characters().findOne({ region: 'us', characterId: player.id });
      expect(stored!.profileStatus, `${player.name} was enriched`).toBe('ok');
    }
  });
});
