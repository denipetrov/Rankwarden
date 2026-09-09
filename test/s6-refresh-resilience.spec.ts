import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import {
  SEASON_STATE_COLLECTION,
  SEASON_TRANSITIONS_COLLECTION,
} from '../src/season/entities/season-state.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SeasonTransitionService } from '../src/season/season-transition.service.js';
import { SpecRepresentationService } from '../src/representation/spec-representation.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson, postJson } from './support/http.js';
import { World } from './support/world.js';

const SEASON = 42;
const NEXT = 43;

/**
 * S6 — season tracking when ingestion is broken, and across a restart.
 *
 * The whole reason season refresh has its own scheduler is that a rollover must
 * be noticed even when sweeps are disabled or failing. These cases break
 * ingestion on purpose and check that season tracking carries on regardless.
 */
describe('S6 — season tracking under failure', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    SEASON_PURGE_DRY_RUN: 'false',
    SEASON_PURGE_REQUIRE_ARCHIVE: 'false',
  };

  let harness: TestApp;
  let db: Db;
  let dbName: string;
  let world: World;
  let baseUrl: string;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const seasons = () => harness.app.get(SeasonService);

  const restart = async () => {
    await harness.close();
    harness = await bootTestApp(world, { ...ENV, MONGODB_DB: dbName });
    db = harness.app.get(MongoService).db;
    baseUrl = await harness.listen();
    await harness.settle();
  };

  beforeAll(async () => {
    world = World.seed({ regions: ['us', 'eu'], players: 40, seed: 613, season: SEASON });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    dbName = harness.dbName;
    baseUrl = await harness.listen();
    await harness.settle();
    // Season 42 needs to be on disk for the restart case to have something to
    // retire once the rollover is finally noticed.
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S6.13 — a rollover is caught with every leaderboard route failing', async () => {
    // Ingestion is comprehensively broken: every ladder 503s.
    for (const bracket of world.brackets('us')) world.fail('us', bracket, 503);

    const sweep = await harness.app.get(LeaderboardService).sweep();
    expect(sweep!.failed, 'the sweep really is failing').toBeGreaterThan(0);

    world.rollover('us', NEXT, new Date('2026-09-02T15:00:00.000Z'));

    const refreshed = await postJson<{ seasons: Record<string, number | string> }>(
      baseUrl,
      '/admin/season-refresh',
    );

    expect(
      refreshed.body.seasons.us,
      'season tracking must not be coupled to ingestion succeeding',
    ).toBe(NEXT);
    expect(seasons().getCurrentSeason('us')).toBe(NEXT);

    const health = await getJson<{ seasons: Record<string, { id: number }> }>(
      baseUrl,
      '/health/seasons',
    );
    expect(health.body.seasons.us.id, 'and it reaches the health endpoint').toBe(NEXT);

    world.clearFailures();
  });

  it('S6.14 — one region failing does not stop the others refreshing', async () => {
    // us cannot answer at all; eu rolls over in the same tick.
    world.fail('us', 'index', 504);
    world.rollover('eu', NEXT, new Date('2026-09-03T04:00:00.000Z'));

    const refreshed = await postJson<{ seasons: Record<string, number | string> }>(
      baseUrl,
      '/admin/season-refresh',
    );

    expect(typeof refreshed.body.seasons.us, 'us reports its error rather than throwing').toBe(
      'string',
    );
    expect(String(refreshed.body.seasons.us)).toMatch(/504/);
    expect(refreshed.body.seasons.eu, 'the loop completes for every remaining region').toBe(NEXT);

    world.clearFailures();
  });

  it('S6.11 — an empty new season is ingested without error', async () => {
    // Day one: every one of the 83 ladders publishes an empty entry list.
    for (const player of world.players.values()) player.ratings.clear();

    const result = await harness.app.get(LeaderboardService).sweep();

    expect(result!.failed, 'an empty ladder is not a failure').toBe(0);
    expect(result!.jobs.every((job) => job.entries === 0)).toBe(true);
    expect(result!.removedCharacters, 'there was nothing stored to remove').toBe(0);
    expect(await characters().countDocuments({ seasonId: NEXT })).toBe(0);

    // No division by zero, and an empty series is skipped rather than stored as
    // a row of zeros that a chart would render as a real observation.
    const summary = await harness.app.get(SpecRepresentationService).snapshot();
    expect(summary.written).toBe(0);
    expect(summary.skipped).toBeGreaterThan(0);
    expect(await db.collection(SPEC_REPRESENTATION_COLLECTION).countDocuments()).toBe(0);
  });

  describe('across a restart', () => {
    it('S6.21 — a rollover that happens while the process is down is still seen', async () => {
      // Both regions have already rolled over in the World, but the persisted
      // state still says season 42 — which is exactly the state a process left
      // behind when it was stopped before the rollover.
      await db.collection(SEASON_STATE_COLLECTION).updateMany(
        {},
        {
          $set: {
            seasonId: SEASON,
            startsAt: new Date('2026-08-18T15:00:00.000Z'),
            endsAt: null,
          },
        },
      );
      expect(await characters().countDocuments({ seasonId: SEASON })).toBeGreaterThan(0);

      // The bootstrap refresh compares against that persisted state. Before it
      // was persisted, the in-memory cache was empty at boot, so this looked
      // like a first observation rather than a change: the rollover branch
      // never ran and the purge was skipped entirely, silently, for exactly the
      // season it was built for.
      await restart();

      const state = await db.collection(SEASON_STATE_COLLECTION).find({}).toArray();
      expect(state.map((entry) => entry.seasonId)).toEqual([NEXT, NEXT]);
      expect(seasons().getCurrentSeason('us')).toBe(NEXT);
      expect(seasons().getCurrentSeason('eu')).toBe(NEXT);
    });

    it('S6.21b — and the purge that follows it runs exactly once', async () => {
      const transitions = harness.app.get(SeasonTransitionService);

      const first = await transitions.run();
      expect(
        first.purged.map((entry) => `${entry.seasonId}:${entry.region}`).sort(),
        'the rollover the restart uncovered retires the old season',
      ).toEqual([`${SEASON}:eu`, `${SEASON}:us`]);
      expect(await characters().countDocuments({ seasonId: SEASON })).toBe(0);

      const second = await transitions.run();
      expect(second.purged, 'a second tick finds nothing left to do').toEqual([]);
      expect(
        await db.collection(SEASON_TRANSITIONS_COLLECTION).countDocuments({ seasonId: SEASON }),
        'one record per season and region, not one per tick',
      ).toBe(2);
    });
  });
});
