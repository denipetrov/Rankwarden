import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { RaidRankingsScheduler } from '../src/raid/raid-rankings.scheduler.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds, type HeldJob } from './support/hold.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';
import { RAIDS_COLLECTION } from '../src/database/collections.js';

/**
 * Where the raid rankings sit among the other jobs: last. With their real
 * gates — nothing at boot, nothing until the first sweep and the first Mythic+
 * pass are done — and stepping aside, mid-run, for any job that starts.
 *
 * Its own file because it needs the live Mythic+ pass switched on and a real
 * wait for idle, which no other raid file wants.
 */
describe('Raid rankings scheduling', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const rankingRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/raid-rankings');
  /** The first page of each board: when, and in what order, boards were started. */
  const boardStarts = () => rankingRequests().filter((request) => request.page === 0);
  const boardsStored = async () =>
    (await db.collection(RAIDS_COLLECTION).find({}).toArray()).reduce(
      (total, raid) =>
        total +
        Object.values((raid.guildsUpdatedAt ?? {}) as Record<string, object>).reduce(
          (sum, byDifficulty) => sum + Object.keys(byDifficulty).length,
          0,
        ),
      0,
    );
  /** Fires the interval's tick by hand: the interval itself is an hour long. */
  const tick = () =>
    (app.app.get(RaidRankingsScheduler) as unknown as { tick(): Promise<void> }).tick();

  beforeAll(async () => {
    world.seed('us', 20, 400, 'season-mn-2');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        RAIDERIO_REGIONS: 'us',
        MPLUS_ENABLED: 'true',
        MPLUS_CATALOGUE_FIRST_EXPANSION: '11',
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_DIFFICULTIES: 'mythic',
        // A real wait, so a run pauses for a job above it instead of ending.
        ARCHIVE_WAIT_FOR_IDLE_MS: '5000',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    await app.settle();
  });

  afterEach(async () => {
    await releaseAllHolds();
    await app.settle();
    app.raiderIo.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reads nothing at boot, though the catalogue it hangs off is loaded', async () => {
    expect(await db.collection(RAIDS_COLLECTION).countDocuments(), 'the catalogue is cheap').toBe(
      3,
    );
    expect(rankingRequests()).toEqual([]);
    expect(await boardsStored()).toBe(0);
    expect(
      logger.matching(/Raid rankings will start once every other job has completed a first pass/),
    ).toHaveLength(1);
  });

  it('first runs after the first sweep and the first Mythic+ pass, in that order', async () => {
    // The sweep opens the warm-up gate, which starts the Mythic+ pass; that
    // pass finishing opens the last gate.
    await app.app.get(LeaderboardService).sweep();
    await app.settle();

    const paths = app.raiderIo.requests.map((request) => request.path);
    const lastRun = paths.lastIndexOf('mythic-plus/runs');
    const firstRanking = paths.indexOf('raiding/raid-rankings');

    expect(lastRun, 'the Mythic+ pass ran').toBeGreaterThan(-1);
    expect(firstRanking, 'and so did the rankings').toBeGreaterThan(-1);
    expect(firstRanking, 'after every page of the pass, not alongside it').toBeGreaterThan(lastRun);
    expect(await boardsStored()).toBe(15);
  });

  it.each<[HeldJob]>([['sweep'], ['enrichment'], ['mplus'], ['archive'], ['mplusArchive']])(
    'pauses mid-run while %s runs, and carries on where it was once it is done',
    async (job) => {
      let release: (() => Promise<void>) | undefined;
      let askedWhileHeld = 0;
      let releasedAt = 0;

      // The job starts as the third board is served: the run could not see it coming.
      app.raiderIo.beforeServe = (request) => {
        if (request.path !== 'raiding/raid-rankings' || request.page !== 0) return;

        // A board already being read finishes its pages; no new one starts.
        if (release && releasedAt === 0) askedWhileHeld += 1;

        if (!release && boardStarts().length === 3) {
          release = holdActive(app.app, job);
          setTimeout(() => {
            releasedAt = Date.now();
            void release!();
          }, 150);
        }
      };

      const startedAt = Date.now();
      await tick();

      // The open raid's five boards, all read: three before the job, two after.
      expect(boardStarts()).toHaveLength(5);
      expect(askedWhileHeld, 'no board was started while the job ran').toBe(0);
      expect(releasedAt - startedAt).toBeGreaterThanOrEqual(140);
      expect(boardStarts()[3].at, 'the fourth board waited for it').toBeGreaterThanOrEqual(
        releasedAt,
      );
      // Said once each, however many boards were waiting.
      expect(
        logger.matching(/Raid rankings paused: a higher-priority job is running/),
      ).toHaveLength(1);
      expect(logger.matching(/Raid rankings resumed/)).toHaveLength(1);
      logger.clear();
      expect(logger.of('warn', /rank/i)).toEqual([]);
    },
  );

  it('waits for a job already running before it starts, rather than skipping the tick', async () => {
    const release = holdActive(app.app, 'mplusArchive');
    const ticking = tick();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rankingRequests(), 'held back').toEqual([]);

    await release();
    await ticking;
    expect(boardStarts()).toHaveLength(5);

    await expectInvariants(db);
  });
});
