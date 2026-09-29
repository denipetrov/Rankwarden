import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const WAIT_MS = 3_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * M4.7-M4.9 — waiting for the Raider.io minute (L11, gap §7.9).
 *
 * Every other file sets `RAIDERIO_BUDGET_WAIT_MS=0`, so a spent minute stops a
 * job at once and the waiting path itself — "wait for the window to roll, then
 * carry on" — has never run. Here the wait is three seconds, and the minute is
 * rolled by moving the budget's clock rather than by sleeping for a minute.
 *
 * Each case runs on its own stretch of the budget's clock, far from the
 * others, so what one case spends is outside the window the next one reads:
 * `RollingWindow` ignores buckets from the future and anything older than a
 * minute, and nothing here can clear it.
 */
describe('Mythic+ budget wait', () => {
  let app: TestApp;
  let db: Db;
  let budget: RaiderIoBudget;
  let realClock: () => number;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  /** Moves the budget onto its own timeline, `offsetMs` ahead of the real clock. */
  const timeline = (offsetMs: number) => {
    budget.now = () => Date.now() + offsetMs;
  };

  const staleRun = async () => {
    const run: Record<string, unknown> = {
      ...(await db.collection(MPLUS_RUNS_COLLECTION).findOne({ region: 'us' })),
      keystoneRunId: 1,
      fetchedAt: new Date(0),
      // Missed by one clean pass already, so the next one prunes it.
      missedSince: new Date(0),
    };
    delete run._id;
    await db.collection(MPLUS_RUNS_COLLECTION).insertOne(run);
  };

  beforeAll(async () => {
    world.seed('us', 40, 500, 'season-mn-2').seed('us', 30, 450, 'season-mn-1');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', RAIDERIO_BUDGET_WAIT_MS: String(WAIT_MS) },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    budget = app.app.get(RaiderIoBudget);
    realClock = budget.now;

    // Catalogued and passed once up front, so no case below spends on either
    // and every request it makes is the one under test.
    await app.app.get(MplusCatalogueService).refresh();
    expect((await app.app.get(MplusService).sweep())!.stoppedEarly).toBeNull();
    app.raiderIo.reset();
    logger.clear();
  });

  afterEach(async () => {
    await releaseAllHolds();
    budget.now = realClock;
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M4.7 waits out a spent minute, then completes the pass', async () => {
    await staleRun();
    timeline(1_000_000);
    budget.record('other', budget.usable);
    expect(budget.allowance()).toBe(0);

    const startedAt = Date.now();
    // The minute rolls about a second into the pass: the whole spend falls out
    // of the window.
    const roll = sleep(1_000).then(() => timeline(1_000_000 + 61_000));
    const result = await app.app.get(MplusService).sweep();
    await roll;

    expect(result!.stoppedEarly).toBeNull();
    expect(result!.regions[0].stoppedEarly).toBeNull();
    expect(result!.regions[0].prunedRuns, 'a waited-out pass is a clean pass').toBe(1);

    const firstRuns = app.raiderIo.requests.find((request) => request.path === 'mythic-plus/runs');
    expect(
      firstRuns!.at - startedAt,
      'the first page waited for the minute',
    ).toBeGreaterThanOrEqual(900);
    expect(logger.of('warn', /budget/)).toEqual([]);
    await expectInvariants(db);
  });

  it('M4.8 stops a pass whose minute stays spent past the wait', async () => {
    await staleRun();
    timeline(2_000_000);
    budget.record('other', budget.usable);

    const startedAt = Date.now();
    const result = await app.app.get(MplusService).sweep();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(WAIT_MS - 100);
    expect(elapsed).toBeLessThan(WAIT_MS + 2_000);
    expect(result!.regions[0].stoppedEarly).toBe('Raider.io budget spent');
    expect(result!.stoppedEarly).toBe('Raider.io budget spent');
    expect(app.raiderIo.countMatching('mythic-plus/runs')).toBe(0);
    expect(result!.regions[0].prunedRuns, 'a stopped pass never prunes').toBe(0);
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ keystoneRunId: 1 }),
      'the stale run is still there',
    ).toBe(1);

    const warnings = logger.of('warn', /budget for the current minute is spent/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/stopping us at page 0/);

    await db.collection(MPLUS_RUNS_COLLECTION).deleteOne({ keystoneRunId: 1 });
  });

  it('M4.9 lets go of the archive wait the moment a live job starts', async () => {
    timeline(3_000_000);
    // The archive's share spent, the rest of the minute free: the archive has to
    // wait, and nothing else does.
    budget.record('mplusArchive', budget.archiveShare);
    expect(budget.allowanceFor('mplusArchive')).toBe(0);
    expect(budget.allowanceFor('mplus')).toBeGreaterThan(0);

    let heldAt = 0;
    const hold = sleep(200).then(() => {
      heldAt = Date.now();
      holdActive(app.app, 'mplus');
    });
    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    const returnedAt = Date.now();
    await hold;

    expect(tick!.stoppedEarly).toBe('a higher-priority job started mid-season');
    expect(tick!.seasons.map((season) => [season.season, season.outcome])).toEqual([
      ['season-mn-1', 'yielded'],
    ]);
    // Within one poll of the hold, not at the end of the three-second wait.
    expect(returnedAt - heldAt).toBeLessThanOrEqual(1_100);
    expect(app.raiderIo.countMatching('mythic-plus/runs'), 'the wait spent nothing').toBe(0);
    expect(
      (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: 'season-mn-1' }))?.archive,
      'no region finished, so nothing is recorded',
    ).toBeUndefined();
  });
});
