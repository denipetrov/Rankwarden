import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { RaidRankingsScheduler } from '../src/raid/raid-rankings.scheduler.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';
import { RAIDS_COLLECTION } from '../src/database/collections.js';

const REGIONS = ['world', 'us', 'eu', 'kr', 'tw'];
const FINISHED = ['tier-mn-1', 'manaforge-omega'];

/**
 * Raid plan R5 — a backfill sharing the process with the jobs above it, as it
 * does in production: several boards at once, each slow, and a real wait for
 * idle. Then a shutdown in the middle of one, and the restart after it.
 */
describe('Raid plan R5 — a backfill among other jobs', () => {
  const ENV = {
    RAID_CATALOGUE_ENABLED: 'true',
    RAID_RANKINGS_ENABLED: 'true',
    RAID_RANKINGS_DIFFICULTIES: 'mythic',
    RAID_RANKINGS_CONCURRENCY: '3',
    ARCHIVE_WAIT_FOR_IDLE_MS: '5000',
  };

  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();
  const seed = World.seed({ regions: ['us'], players: 5 });
  /** The finished raids' boards that had been read when the app was shut down. */
  let settledAtShutdown: string[] = [];

  const rankingRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/raid-rankings');
  const starts = () => rankingRequests().filter((request) => request.page === 0);
  const started = () => starts().map((request) => `${request.params.raid}/${request.region}`);
  const tick = () =>
    (app.app.get(RaidRankingsScheduler) as unknown as { tick(): Promise<void> }).tick();
  /** Makes every board of the finished raids owed again: ten of them. */
  const forgetFinished = () =>
    db
      .collection(RAIDS_COLLECTION)
      .updateMany({ slug: { $in: FINISHED } }, { $unset: { guilds: '', guildsUpdatedAt: '' } });
  const stamped = async () =>
    (await db.collection(RAIDS_COLLECTION).find({}).toArray()).flatMap((raid) =>
      Object.keys((raid.guildsUpdatedAt ?? {}) as object).map((region) => `${raid.slug}/${region}`),
    );

  beforeAll(async () => {
    app = await bootTestApp(seed, ENV, undefined, logger, world);
    db = app.app.get(MongoService).db;
    await app.settle();
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
    app.raiderIo.reset();
    logger.clear();
  });

  afterEach(async () => {
    await releaseAllHolds();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('R5.1 a slow backfill pauses for enrichment and carries on, reading no board twice', async () => {
    await forgetFinished();
    // A cold page upstream takes seconds; here, long enough to be mid-board
    // when the job above starts.
    app.raiderIo.slow('raiding/raid-rankings', 30);
    let heldAt = 0;
    let releasedAt = 0;

    app.raiderIo.beforeServe = (request) => {
      if (request.path !== 'raiding/raid-rankings' || request.page !== 0) return;
      // Requests are counted as they are made and served after their delay, so
      // with three boards going the count moves in threes.
      if (heldAt !== 0 || starts().length < 5) return;

      heldAt = Date.now();
      const release = holdActive(app.app, 'enrichment');
      setTimeout(() => {
        releasedAt = Date.now();
        void release();
      }, 250);
    };

    await tick();

    expect(heldAt, 'enrichment did start mid-run').toBeGreaterThan(0);
    expect(releasedAt - heldAt).toBeGreaterThanOrEqual(240);
    expect(app.app.get(RaidRankingsService).lastStatus.lastRun).toMatchObject({
      boards: 15,
      failed: 0,
      stopped: null,
    });
    expect(new Set(started()).size, 'no board read twice').toBe(15);
    expect(started()).toHaveLength(15);

    // The pause is real: with three boards going, the three in flight finish —
    // their later pages included — and no new one starts until enrichment ends.
    const duringHold = rankingRequests().filter(
      (request) => request.at > heldAt + 120 && request.at < releasedAt,
    );
    expect(duringHold.filter((request) => request.page === 0)).toEqual([]);
    expect(starts().filter((request) => request.at >= releasedAt).length).toBeGreaterThan(0);
    expect(app.raiderIo.peakInFlight).toBeLessThanOrEqual(3);

    expect(logger.matching(/Raid rankings paused: a higher-priority job is running/)).toHaveLength(
      1,
    );
    expect(logger.matching(/Raid rankings resumed/)).toHaveLength(1);
    expect(logger.of('warn', /rank/i)).toEqual([]);
    await expectInvariants(db, undefined, world);
  });

  it('R5.5 a shutdown during a pause ends the run when the job ends, with no board read after', async () => {
    app.raiderIo.reset();
    logger.clear();
    await forgetFinished();
    app.raiderIo.slow('raiding/raid-rankings', 20);
    let release: (() => Promise<void>) | undefined;

    app.raiderIo.beforeServe = (request) => {
      if (request.path !== 'raiding/raid-rankings' || request.page !== 0) return;
      if (!release && starts().length >= 6) release = holdActive(app.app, 'sweep');
    };

    const ticking = tick();
    await expect.poll(() => release !== undefined, { timeout: 5_000 }).toBe(true);
    // Let the boards in flight finish, so the run is doing nothing but waiting.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = started().length;

    // What Nest calls on the scheduler as the application closes.
    app.app.get(RaidRankingsScheduler).onModuleDestroy();
    await release!();
    await ticking;

    expect(started(), 'the wait ended, and nothing was started after it').toHaveLength(before);
    expect(app.app.get(RaidRankingsService).lastStatus.lastRun).toMatchObject({
      failed: 0,
      stopped: 'the application is shutting down',
    });
    expect(logger.of('error')).toEqual([]);
    expect(before).toBeLessThan(15);

    settledAtShutdown = (await stamped()).filter(
      (entry) => !entry.startsWith('the-venomous-abyss'),
    );
    await app.close();
    expect(logger.of('error'), 'nothing about a closed database').toEqual([]);
  });

  it('R5.6 the restart reads what the shutdown left, and none of what was settled', async () => {
    const settled = settledAtShutdown;
    const owed = FINISHED.flatMap((slug) => REGIONS.map((region) => `${slug}/${region}`)).filter(
      (entry) => !settled.includes(entry),
    );
    expect(owed.length, 'the shutdown did leave boards unread').toBeGreaterThan(0);
    expect(settled.length, 'and had read some').toBeGreaterThan(0);

    app = await bootTestApp(seed, { ...ENV, MONGODB_DB: app.dbName }, undefined, logger, world);
    db = app.app.get(MongoService).db;
    await app.settle();
    expect(rankingRequests(), 'nothing at boot, restart or not').toEqual([]);

    await app.app.get(LeaderboardService).sweep();
    await app.settle();

    // The open raid, as every run; then exactly the boards never read.
    expect([...started()].sort()).toEqual(
      [...REGIONS.map((region) => `the-venomous-abyss/${region}`), ...owed].sort(),
    );
    expect((await stamped()).length).toBe(15);
    await expectInvariants(db, undefined, world);
  });
});
