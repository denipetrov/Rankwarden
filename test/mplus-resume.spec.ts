import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { expectInvariants, expectMplusStoredMatchesServed } from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
const PAGES = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * F1 — M4.2 with the fix: a pass that meets live PvP ingestion pauses at its
 * next batch boundary and resumes where it was, rather than stopping and
 * leaving every later region for a whole interval.
 *
 * Its own file for `MPLUS_YIELD_WAIT_MS`: the harness sets it to 0, and a
 * pause needs a wait long enough to outlast the hold.
 */
describe('Mythic+ pass pausing for live ingestion', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  const pagesOf = (region: string) =>
    app.raiderIo.requests
      .filter((request) => request.path === 'mythic-plus/runs' && request.region === region)
      .map((request) => request.page!)
      .sort((a, b) => a - b);

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
        MPLUS_YIELD_WAIT_MS: '5000',
      },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
  });

  afterEach(async () => {
    await releaseAllHolds();
    app.raiderIo.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M4.2 enrichment starting mid-region pauses the pass, which then reads every region', async () => {
    let release: (() => Promise<void>) | null = null;
    app.raiderIo.beforeServe = (request) => {
      if (
        !release &&
        request.path === 'mythic-plus/runs' &&
        request.region === 'eu' &&
        request.page === 2
      ) {
        release = holdActive(app.app, 'enrichment');
        // Enrichment finishes a while later, on its own.
        void sleep(200).then(() => release!());
      }
    };

    const result = (await app.app.get(MplusService).sweep())!;

    expect(result.stoppedEarly).toBeNull();
    expect(result.regions.map((region) => [region.region, region.stoppedEarly])).toEqual([
      ['us', null],
      ['eu', null],
      ['kr', null],
    ]);
    // Resumed where it was: each of Europe's pages read once, not from the top.
    expect(pagesOf('eu')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pagesOf('kr')).toHaveLength(PAGES);
    expect(result.pausedMs).toBeGreaterThanOrEqual(150);
    for (const region of ['us', 'eu', 'kr']) {
      await expectMplusStoredMatchesServed(db, world, { season: SEASON, region, maxPages: PAGES });
    }
    await expectInvariants(db);
  });

  it('M4.2 a sweep already running when the pass starts is waited for too', async () => {
    const release = holdActive(app.app, 'sweep');
    const pass = app.app.get(MplusService).sweep();
    await sleep(100);
    expect(app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/runs')).toEqual(
      [],
    );
    await release();

    const result = (await pass)!;
    expect(result.stoppedEarly).toBeNull();
    expect(result.regions).toHaveLength(3);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: SEASON })).toBe(
      3 * PAGES * 20,
    );
  });
});
