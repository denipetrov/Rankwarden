import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ARCHIVE_SEASONS_COLLECTION } from '../src/archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { SEASON_TRANSITIONS_COLLECTION } from '../src/season/entities/season-state.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SeasonStateRepository } from '../src/season/season-state.repository.js';
import { SeasonTransitionService } from '../src/season/season-transition.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World } from './support/world.js';

const SEASON = 42;
const NEXT = 43;

/**
 * S6.23 — the two escape hatches on the season purge.
 *
 * Its own file because both are configuration, and `ConfigModule` reads the
 * environment once per module graph. Neither variable is set here: the point is
 * to assert what the *defaults* do, which is the configuration a deployment
 * that has thought about none of this will be running.
 */
describe('S6.23 — season purge escape hatches', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    // SEASON_PURGE_DRY_RUN deliberately unset: the default is what is under test.
    SEASON_PURGE_REQUIRE_ARCHIVE: 'false',
  };

  let harness: TestApp;
  let db: Db;
  let transitions: SeasonTransitionService;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const sweep = async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us'], players: 30, seed: 23, season: SEASON }),
      ENV,
    );
    db = harness.app.get(MongoService).db;
    transitions = harness.app.get(SeasonTransitionService);
    await harness.settle();
    await sweep();

    // Roll over so the gate is open and there is something to retire. The start
    // is in the past, so `run()` needs no fabricated clock.
    harness.world.rollover('us', NEXT, new Date('2026-09-02T15:00:00.000Z'));
    for (const [index, player] of [...harness.world.players.values()].entries()) {
      harness.world.setRating(player.id, '3v3', 1800 + index);
    }
    await harness.app.get(SeasonService).refresh('us');
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('defaults to a dry run, so an unconfigured deployment deletes nothing', async () => {
    expect(transitions.isDryRun, 'the default must be the safe one').toBe(true);
  });

  it('purges a season with no archive marker when the interlock is off', async () => {
    expect(
      await db.collection(ARCHIVE_SEASONS_COLLECTION).countDocuments({ seasonId: SEASON }),
      'nothing has archived season 42',
    ).toBe(0);

    const plan = await transitions.plan();

    expect(plan.permitted).toBe(true);
    expect(
      plan.candidates.find((entry) => entry.region === 'us' && entry.seasonId === SEASON),
      'with the interlock off, an unarchived season is a candidate',
    ).toBeDefined();
    expect(plan.blockedByArchive, 'nothing is held back').toEqual([]);
    expect(plan.requireArchive).toBe(false);
  });

  it('a dry run reports the full plan and leaves every document in place', async () => {
    const before = await characters().countDocuments({ region: 'us', seasonId: SEASON });
    expect(before, 'season 42 is still live').toBeGreaterThan(0);

    const outcome = await transitions.run();
    const purged = outcome.purged.find((entry) => entry.seasonId === SEASON);

    expect(purged, 'the season is reported as retired').toBeDefined();
    expect(purged!.dryRun).toBe(true);
    expect(
      purged!.removed[CHARACTERS_COLLECTION],
      'a dry run counts what it would delete rather than deleting it',
    ).toBe(before);
    expect(await characters().countDocuments({ region: 'us', seasonId: SEASON })).toBe(before);
  });

  it('records the dry run, but not in a way that suppresses the real one', async () => {
    const record = await db
      .collection(SEASON_TRANSITIONS_COLLECTION)
      .findOne({ seasonId: SEASON, region: 'us' });

    expect(record, 'a dry run is still recorded, so it can be reviewed').toBeTruthy();
    expect(record!.dryRun).toBe(true);

    // The load-bearing half. `purgedPairs` filters on `dryRun: false`; without
    // that filter a single dry run would permanently suppress the real purge and
    // the season would never be retired at all.
    const purged = await harness.app.get(SeasonStateRepository).purgedPairs();
    expect(purged.has(`${SEASON}:us`), 'a dry run must not count as done').toBe(false);

    // Which is why the season is still a candidate on the next tick.
    const plan = await transitions.plan();
    expect(plan.candidates.find((entry) => entry.seasonId === SEASON)).toBeDefined();
  });
});
