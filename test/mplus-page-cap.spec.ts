import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MAX_RUNS_PAGE, RUNS_PER_PAGE } from '../src/raiderio/raiderio.constants.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusStoredMatchesServed,
  expectNoOrphanMplusCharacters,
} from './support/invariants.js';
import { member, MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
const FULL = MAX_RUNS_PAGE + 1;
/** A size budget, as `s7-large-ladder.spec.ts` keeps: this file is the suite's heaviest. */
const BUDGET_MS = 45_000;

/**
 * M2.5 — the real page cap: 1,001 pages, and never page 1001 (L9).
 *
 * Every other file caps a pass at five pages, so the boundary the endpoint
 * actually enforces — `page` above 1000 is a 400 — has only ever been met at
 * five. Here a board deeper than the cap is read to the cap and not a page
 * further, and then a board just short of it ends on its own empty page.
 *
 * A thousand characters shared across twenty thousand runs, rather than three
 * new ones per run, so the fold is exercised at depth without the file being a
 * test of how fast sixty thousand characters can be written.
 */
describe('Mythic+ pass at the real page cap', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();
  const pool = Array.from({ length: 1_000 }, (_unused, index) =>
    member(20_000 + index, `Deep${index}`),
  );

  /** The top `runs` of one fixed board: the same run ids however deep it is cut. */
  const fill = (runs: number) => {
    world.runs = [];
    for (let index = 0; index < runs; index += 1) {
      world.addRun({
        keystoneRunId: 900_000 + index,
        region: 'us',
        season: SEASON,
        score: 30_000 - index,
        dungeon: index % 3,
        members: [0, 1, 2, 3, 4].map((slot) => pool[(index * 7 + slot * 131) % pool.length]),
      });
    }
    world.invalidate();
  };

  beforeAll(async () => {
    world.cacheRankings = true;
    fill(FULL * RUNS_PER_PAGE + 20);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us',
        RAIDERIO_MAX_PAGES: String(FULL),
        RAIDERIO_PAGE_BATCH: '50',
        // A thousand requests in one pass: the minute has to hold them, or the
        // budget rather than the cap is what ends it.
        RAIDERIO_MINUTE_LIMIT: '100000',
      },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M2.5 reads pages 0-1000 exactly once each, and never asks for page 1001', async () => {
    const startedAt = Date.now();
    const result = await app.app.get(MplusService).sweep();

    const pages = app.raiderIo.requests
      .filter((request) => request.path === 'mythic-plus/runs')
      .map((request) => request.page!);
    expect(pages).toHaveLength(FULL);
    expect(new Set(pages).size, 'each page once').toBe(FULL);
    expect(Math.max(...pages)).toBe(MAX_RUNS_PAGE);

    const us = result!.regions[0];
    expect(us).toMatchObject({
      pagesPlanned: FULL,
      pagesFetched: FULL,
      pagesFailed: 0,
      stoppedEarly: null,
    });
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: SEASON })).toBe(
      FULL * RUNS_PER_PAGE,
    );

    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: FULL,
    });
    await expectNoOrphanMplusCharacters(db);
    await expectInvariants(db);
    expect(Date.now() - startedAt, 'size budget').toBeLessThan(BUDGET_MS);
  }, 120_000);

  it('M2.5 a board just short of the cap ends on its own empty page, with no failure, and is pruned', async () => {
    // 19,990 runs: page 999 holds the last ten, page 1000 is empty.
    fill(FULL * RUNS_PER_PAGE - 30);
    app.raiderIo.reset();

    const result = await app.app.get(MplusService).sweep();

    const us = result!.regions[0];
    expect(us.pagesFailed).toBe(0);
    expect(us.stoppedEarly).toBeNull();
    expect(us.prunedRuns, 'the thirty that left the board').toBe(30);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: SEASON })).toBe(
      FULL * RUNS_PER_PAGE - 30,
    );
    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: FULL,
    });
  }, 120_000);
});
