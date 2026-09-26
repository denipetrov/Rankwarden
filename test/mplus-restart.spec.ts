import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import {
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from '../src/mplus-season/mplus-season-events.service.js';
import { MplusSeasonService } from '../src/mplus-season/mplus-season.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive } from './support/hold.js';
import {
  expectInvariants,
  expectMplusStoredMatchesServed,
  expectNoOrphanMplusCharacters,
} from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const LIVE = 'season-mn-2';
const FINISHED = 'season-mn-1';

/**
 * M11.1-M11.5 — close and boot again with identical configuration, as
 * `s9-restart.spec.ts` does for the PvP side.
 *
 * What survives a restart is exactly what is persisted: markers, season state,
 * cutoff attempts. What does not — the in-memory budget window — is pinned too,
 * so that a known gap stays a documented behaviour rather than an accident.
 */
describe('Mythic+ across a restart', () => {
  const ENV = {
    RAIDERIO_REGIONS: 'us,eu',
    // One page a batch, so the archive re-checks priority between pages.
    RAIDERIO_PAGE_BATCH: '1',
    // Only for M11.5, where a real scheduler starts the pass; nothing else
    // warms live ingestion up, so no other case sees a scheduled pass.
    MPLUS_ENABLED: 'true',
  };
  const world = new MplusWorld();
  const pvp = World.seed({ regions: ['us'], players: 5 });
  const events: MplusSeasonTransitionEvent[] = [];
  let app: TestApp;
  let db: Db;

  const boot = async () => {
    app = await bootTestApp(pvp, ENV, undefined, undefined, world);
    db = app.app.get(MongoService).db;
    app.app.get(MplusSeasonEvents).transitions$.subscribe((event) => events.push(event));
  };
  const restart = async () => {
    await app.close();
    await boot();
  };
  const pass = async () => {
    const result = await app.app.get(MplusService).sweep();
    expect(result).not.toBeNull();

    return result!;
  };
  const cutoffsOf = async (region: string) =>
    (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: LIVE }))?.cutoffs?.[region];

  beforeAll(async () => {
    world
      .seed('us', 40, 500, LIVE)
      .seed('eu', 30, 480, LIVE)
      .seed('us', 60, 450, FINISHED)
      .seed('eu', 60, 440, FINISHED);
    await boot();
    await pass();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M11.2 a restart with nothing changed announces nothing and writes nothing', async () => {
    const before = await db
      .collection(MPLUS_SEASON_STATE_COLLECTION)
      .find({})
      .sort({ region: 1 })
      .toArray();
    expect(before.map((state) => state.region)).toEqual(['eu', 'us']);

    await restart();
    events.length = 0;
    await app.app.get(MplusSeasonService).observe();

    expect(events).toEqual([]);
    expect(
      await db.collection(MPLUS_SEASON_STATE_COLLECTION).find({}).sort({ region: 1 }).toArray(),
      'observedAt included: nothing was rewritten',
    ).toEqual(before);
  });

  it('M11.3 the Raider.io budget forgets the minute on restart (known gap, §4.0.1)', async () => {
    const spent = app.app.get(RaiderIoBudget);
    spent.record('other', spent.usable);
    expect(spent.allowance()).toBe(0);

    await restart();

    // A fresh window: the minute spent before the restart is not counted, so
    // the first pass after boot is not throttled by it.
    expect(app.app.get(RaiderIoBudget).allowance()).toBe(app.app.get(RaiderIoBudget).usable);
    expect((await pass()).stoppedEarly).toBeNull();
  });

  it('M11.4 cutoff attempts survive a restart, so the cap is not reset by one', async () => {
    app.raiderIo.failWith('season-cutoffs&region:us', { status: 503 });
    await pass();
    await pass();
    expect(await cutoffsOf('us')).toMatchObject({ status: 'failed', attempts: 2 });

    await restart();
    app.raiderIo.failWith('season-cutoffs&region:us', { status: 503 });
    await pass();

    expect(await cutoffsOf('us')).toMatchObject({ status: 'unavailable', attempts: 3 });
  });

  it('M11.1 a partial archive resumes where it stopped', async () => {
    // A live pass starts as the US's last page is served: the US is finished,
    // Europe never begins, and the marker records the US alone.
    let release: (() => Promise<void>) | null = null;
    app.raiderIo.beforeServe = (request) => {
      if (
        !release &&
        request.season === FINISHED &&
        request.region === 'us' &&
        request.page === 2
      ) {
        release = holdActive(app.app, 'mplus');
      }
    };
    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    await (release as (() => Promise<void>) | null)?.();
    app.raiderIo.beforeServe = undefined;

    expect(tick!.seasons.map((season) => season.outcome)).toEqual(['yielded']);
    const partial = (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: FINISHED }))!
      .archive;
    expect(partial.status).toBe('partial');
    expect(Object.keys(partial.regions)).toEqual(['us']);

    await restart();
    const resumed = await app.app.get(MplusArchiveService).archiveBacklog();

    expect(resumed!.seasons.map((season) => [season.season, season.regions])).toEqual([
      [FINISHED, ['eu']],
    ]);
    expect(
      app.raiderIo.requests.filter(
        (request) =>
          request.path === 'mythic-plus/runs' &&
          request.season === FINISHED &&
          request.region === 'us',
      ),
      'the US board is not read again',
    ).toEqual([]);
    // Its cutoffs are, once: they are read as the season completes, and a
    // partial marker never did.
    expect(
      app.raiderIo.requests
        .filter((request) => request.path === 'mythic-plus/season-cutoffs')
        .map((request) => request.region)
        .sort(),
    ).toEqual(['eu', 'us']);
    const complete = (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: FINISHED }))!
      .archive;
    expect(complete.status).toBe('complete');
    expect(complete.regions.us.archivedAt).toEqual(partial.regions.us.archivedAt);
    await expectInvariants(db);
  });

  it('M11.5 a restart during a scheduled pass drains it, and the next pass completes', async () => {
    // The real scheduler starts the pass, on the PvP warm-up. Slow pages keep it
    // running when close is called; close waits for it rather than cutting it off.
    app.raiderIo.delayMs = 30;
    await holdActive(app.app, 'sweep')();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.app.get(MplusService).isRunning, 'the scheduled pass is mid-region').toBe(true);

    await restart();

    const result = await pass();
    expect(result.stoppedEarly).toBeNull();
    for (const region of ['us', 'eu']) {
      const ids = await db
        .collection(MPLUS_RUNS_COLLECTION)
        .distinct('keystoneRunId', { season: LIVE, region });
      expect(ids.length, `no duplicate runs in ${region}`).toBe(
        await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: LIVE, region }),
      );
      await expectMplusStoredMatchesServed(db, world, { season: LIVE, region, maxPages: 5 });
    }
    await expectNoOrphanMplusCharacters(db);
    await expectInvariants(db);
  });
});
