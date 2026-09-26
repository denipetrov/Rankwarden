import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import {
  expectInvariants,
  expectMplusStoredMatchesServed,
  snapshotMplusCharacters,
} from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
const PAGES = 10;

/**
 * M4.5 / M4.6 — the live pass yielding *during* itself (L10).
 *
 * `mplus-coordination.spec.ts` starts the higher job before the pass does, so
 * only the check at the top of the pass is ever reached. These start it
 * mid-pass, from inside a page being served, so the two checks the pass relies
 * on for minutes at a time are the ones exercised: before each batch inside a
 * region, and between regions.
 *
 * Two batches a region (ten pages, five a batch), because with one batch the
 * inside-a-region check is never reached.
 *
 * With the harness's `MPLUS_YIELD_WAIT_MS=0` a pass stops at those checks, which
 * is what these pin; pausing and resuming is `mplus-resume.spec.ts`.
 */
describe('Mythic+ pass yielding mid-pass', () => {
  let app: TestApp;
  let mplus: MplusService;
  let db: Db;
  const world = new MplusWorld();

  const runsRequests = (region?: string) =>
    app.raiderIo.requests.filter(
      (request) =>
        request.path === 'mythic-plus/runs' && (region === undefined || request.region === region),
    );

  /** Holds a sweep active from the moment `region`'s page `page` is served. */
  const sweepFrom = (region: string, page: number) => {
    let release: (() => Promise<void>) | null = null;

    app.raiderIo.beforeServe = (request) => {
      if (
        !release &&
        request.path === 'mythic-plus/runs' &&
        request.region === region &&
        request.page === page
      ) {
        release = holdActive(app.app, 'sweep');
      }
    };

    return () => release;
  };

  beforeAll(async () => {
    world
      .seed('us', PAGES * 20, 900, SEASON)
      .seed('eu', PAGES * 20, 880, SEASON)
      .seed('kr', PAGES * 20, 860, SEASON);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us,eu,kr',
        RAIDERIO_MAX_PAGES: String(PAGES),
        RAIDERIO_PAGE_BATCH: '5',
      },
      undefined,
      undefined,
      world,
    );
    mplus = app.app.get(MplusService);
    db = app.app.get(MongoService).db;
  });

  afterEach(async () => {
    await releaseAllHolds();
    app.raiderIo.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M4.5 yields at the next batch boundary inside a region', async () => {
    const held = sweepFrom('us', 2);

    const result = await mplus.sweep();
    expect(held(), 'the sweep was started mid-batch').not.toBeNull();

    const us = result!.regions.find((region) => region.region === 'us')!;
    // The batch in flight when the sweep started is finished and written: a
    // yield abandons what is next, not what is already paid for.
    expect(
      runsRequests('us')
        .map((request) => request.page)
        .sort((a, b) => a! - b!),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(us.pagesFetched).toBe(5);
    expect(us.stoppedEarly).toBe('live PvP ingestion started');
    expect(us.prunedRuns, 'a stopped region is never pruned').toBe(0);
    expect(result!.stoppedEarly).toBe('live PvP ingestion started');

    // Nothing after the yield: the regions behind it are not started.
    expect(result!.regions.map((region) => region.region)).toEqual(['us']);
    expect(runsRequests('eu')).toHaveLength(0);
    expect(runsRequests('kr')).toHaveLength(0);

    // What was read is still folded and written, so a yield loses no score.
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'us' })).toBe(100);
    expect(us.characters).toBeGreaterThan(0);
    await expectMplusStoredMatchesServed(db, world, { season: SEASON, region: 'us', maxPages: 5 });
    await expectInvariants(db);
  });

  it('M4.6 yields between regions, having finished and pruned the one it was in', async () => {
    // A run the last pass stored and this one will not see, so "pruned" is
    // observable rather than inferred from a zero.
    const stale: Record<string, unknown> = {
      ...(await db.collection(MPLUS_RUNS_COLLECTION).findOne({ region: 'us' })),
      keystoneRunId: 1,
      fetchedAt: new Date(0),
      // Missed by one clean pass already, so the next one prunes it.
      missedSince: new Date(0),
    };
    delete stale._id;
    await db.collection(MPLUS_RUNS_COLLECTION).insertOne(stale);
    const before = await snapshotMplusCharacters(db, SEASON, 'us');

    sweepFrom('us', PAGES - 1);
    const result = await mplus.sweep();

    const us = result!.regions.find((region) => region.region === 'us')!;
    expect(us.stoppedEarly).toBeNull();
    expect(us.pagesFetched).toBe(PAGES);
    expect(us.prunedRuns).toBe(1);

    expect(result!.stoppedEarly).toBe('live PvP ingestion started');
    expect(result!.regions.map((region) => region.region)).toEqual(['us']);
    expect(runsRequests('eu')).toHaveLength(0);
    expect(runsRequests('kr')).toHaveLength(0);
    expect(await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ region: 'eu' })).toBe(
      0,
    );

    // The figures are recorded for what was read, and only for that.
    const cutoffRequests = app.raiderIo.requests.filter(
      (request) => request.path === 'mythic-plus/season-cutoffs',
    );
    expect(cutoffRequests.map((request) => request.region)).toEqual(['us']);
    expect(
      (await db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION).distinct('region')).sort(),
    ).toEqual(['all', 'us']);

    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: PAGES,
      before,
    });
    await expectInvariants(db);
  });

  /** Enrichment starting as Europe's page 2 is served, released after the pass returns. */
  const enrichmentFromEuPage2 = async () => {
    let release: (() => Promise<void>) | null = null;
    app.raiderIo.beforeServe = (request) => {
      if (
        !release &&
        request.path === 'mythic-plus/runs' &&
        request.region === 'eu' &&
        request.page === 2
      ) {
        release = holdActive(app.app, 'enrichment');
      }
    };

    const result = await mplus.sweep();
    app.raiderIo.beforeServe = undefined;
    await (release as (() => Promise<void>) | null)?.();

    return result!;
  };

  it('M4.2 with MPLUS_YIELD_WAIT_MS=0, enrichment starting mid-pass ends it for every region after', async () => {
    const result = await enrichmentFromEuPage2();

    const us = result.regions.find((region) => region.region === 'us')!;
    const eu = result.regions.find((region) => region.region === 'eu')!;
    expect(us.stoppedEarly).toBeNull();
    expect(eu).toMatchObject({
      stoppedEarly: 'live PvP ingestion started',
      pagesFetched: 5,
      prunedRuns: 0,
    });
    expect(
      result.regions.map((region) => region.region),
      'Korea is never started',
    ).toEqual(['us', 'eu']);
    expect(runsRequests('kr')).toHaveLength(0);
    expect(app.app.get(RaiderIoBudget).mplusOutlook?.stoppedEarly).toBe(
      'live PvP ingestion started',
    );

    // Released: nothing picks the pass back up before the next interval.
    const before = app.raiderIo.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(app.raiderIo.requests.length).toBe(before);
  });
});
