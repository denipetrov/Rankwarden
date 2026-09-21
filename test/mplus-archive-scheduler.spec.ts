import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MPLUS_ARCHIVE_RUNS_COLLECTION } from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * The archive's scheduling, with its real gates: it must not start until the
 * first sweep, the first enrichment pass and the first live Mythic+ pass have
 * all finished.
 *
 * Its own file because it needs the archive and the live pass switched on,
 * which no other file wants.
 */
describe('Mythic+ archive scheduling', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  beforeAll(async () => {
    world.seed('us', 20, 600, 'season-mn-1').seed('us', 20, 400, 'season-mn-2');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        RAIDERIO_REGIONS: 'us',
        MPLUS_ENABLED: 'true',
        MPLUS_ARCHIVE_ENABLED: 'true',
        MPLUS_CATALOGUE_FIRST_EXPANSION: '11',
        // Enrichment off releases its half of the warm-up gate at boot, so the
        // sweep is the one event that opens it.
      },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
    await app.settle();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('does nothing at boot, before live ingestion has warmed up', async () => {
    // No sweep has run (INGEST_RUN_ON_STARTUP is off in the harness), so no
    // gate has opened and neither Mythic+ job has made a request.
    expect(app.raiderIo.requests).toEqual([]);
    expect(await db.collection(MPLUS_SEASONS_COLLECTION).countDocuments()).toBe(0);
  });

  it('archives only after the live Mythic+ pass has run', async () => {
    // The first sweep opens the warm-up gate. That starts the live pass; the
    // live pass finishing opens the Mythic+ gate; only then does the archive go.
    await app.app.get(LeaderboardService).sweep();
    await app.settle();

    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments(), 'the live pass ran').toBe(
      20,
    );
    expect(
      (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: 'season-mn-1' }))?.archive
        ?.status,
      'and the archive ran',
    ).toBe('complete');
    expect(await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments()).toBe(20);

    // The order, not just the outcome. Every live runs request precedes every
    // archive one: the archive went after the live pass had finished, rather
    // than alongside it.
    const requests = app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/runs');
    // Told apart by season: the live pass reads the running one, the archive
    // the finished one, and both read the region's own board.
    const lastLive = requests.map((request) => request.season).lastIndexOf('season-mn-2');
    const firstArchive = requests.map((request) => request.season).indexOf('season-mn-1');

    expect(lastLive).toBeGreaterThanOrEqual(0);
    expect(firstArchive).toBeGreaterThan(lastLive);
  });
});
