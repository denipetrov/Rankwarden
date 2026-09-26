import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService, type MplusSweepResult } from '../src/mplus/mplus.service.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MplusSpecRepresentationService } from '../src/mplus-representation/mplus-spec-representation.service.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MplusCatalogueRepository } from '../src/mplus-season/mplus-catalogue.repository.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectMplusCutoffsWellFormed } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld, WORLD_DUNGEONS } from './support/mplus-world.js';
import { World } from './support/world.js';

const LIVE = 'season-mn-2';
const FINISHED = 'season-mn-1';

/**
 * M7.1, M7.4, M8.3-M8.5 — the figures a pass and the archive record after
 * their runs: spec representation and cutoffs.
 *
 * Both are secondary to the runs, and both are promised never to fail the job
 * that records them (K8, and the representation half of gap §7.4). Each
 * promise is tested by making the thing it guards fail and checking that the
 * job's own result is untouched and one error line says why.
 */
describe('Mythic+ figures: representation and cutoffs', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const seasonDoc = (slug: string) => db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug });
  const cutoffsOf = async (slug: string, region: string) =>
    (await seasonDoc(slug))?.cutoffs?.[region] as
      { status: string; attempts: number; lastError?: string } | undefined;
  const errors = () => logger.of('error');

  /** A stored run no pass will see again, so "the prune ran" is a count, not an inference. */
  const plantStaleRun = async () => {
    const run: Record<string, unknown> = {
      ...(await db.collection(MPLUS_RUNS_COLLECTION).findOne({ season: LIVE, region: 'us' })),
      keystoneRunId: 1,
      fetchedAt: new Date(0),
    };
    delete run._id;
    await db.collection(MPLUS_RUNS_COLLECTION).insertOne(run);
  };

  const pass = async (): Promise<MplusSweepResult> => {
    const result = await app.app.get(MplusService).sweep();
    expect(result).not.toBeNull();

    return result!;
  };

  /** Forgets the finished season's archive, so the next tick archives it again. */
  const unarchive = async () => {
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: FINISHED }, { $unset: { archive: '', cutoffs: '' } });
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: FINISHED });
    await db.collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION).deleteMany({ season: FINISHED });
    await db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION).deleteMany({ season: FINISHED });
  };

  beforeAll(async () => {
    world
      .seed('us', 30, 500, LIVE)
      .seed('eu', 20, 480, LIVE)
      .seed('us', 30, 450, FINISHED)
      .seed('eu', 20, 440, FINISHED);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us,eu' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    await app.app.get(MplusCatalogueService).refresh();
    await pass();
    app.raiderIo.reset();
    logger.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M8.3 a success resets the attempt count', async () => {
    expect((await cutoffsOf(LIVE, 'us'))?.status).toBe('ok');

    app.raiderIo.failWith('season-cutoffs&region:us', { status: 503, times: 1 });
    await pass();
    expect(await cutoffsOf(LIVE, 'us')).toMatchObject({ status: 'failed', attempts: 1 });
    await expectMplusCutoffsWellFormed(db, ['us', 'eu']);

    await pass();
    const read = await cutoffsOf(LIVE, 'us');
    expect(read).toMatchObject({ status: 'ok', attempts: 0 });
    expect(read!.lastError, 'the old error goes with the failure').toBeUndefined();
    await expectMplusCutoffsWellFormed(db, ['us', 'eu']);

    app.raiderIo.failWith('season-cutoffs&region:us', { status: 503, times: 1 });
    await pass();
    expect(await cutoffsOf(LIVE, 'us'), 'counted from zero again, not from 1').toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    await expectMplusCutoffsWellFormed(db, ['us', 'eu']);

    await pass();
    expect((await cutoffsOf(LIVE, 'us'))?.status).toBe('ok');
  });

  it('M8.4a a cutoffs payload that fails the schema is recorded as failed, with the path', async () => {
    app.raiderIo.corrupt('season-cutoffs&region:eu', { cutoffs: 'not an object' }, 1);
    const result = await pass();

    expect(result.stoppedEarly).toBeNull();
    const eu = await cutoffsOf(LIVE, 'eu');
    expect(eu).toMatchObject({ status: 'failed', attempts: 1 });
    expect(eu!.lastError).toMatch(/schema issues: cutoffs:/);
    expect(errors(), 'a recorded failure is a warning, not an error').toEqual([]);

    await pass();
    expect((await cutoffsOf(LIVE, 'eu'))?.status).toBe('ok');
  });

  it('M8.4b cutoffs that cannot be written never fail the pass', async () => {
    await plantStaleRun();
    // Twice: once for the result, once for the failure record written in its
    // place — the second is what escapes `record` and reaches the pass.
    vi.spyOn(app.app.get(MplusCatalogueRepository), 'recordCutoffs')
      .mockRejectedValueOnce(new Error('cutoffs write refused'))
      .mockRejectedValueOnce(new Error('cutoffs write refused'));

    const result = await pass();

    expect(result.stoppedEarly).toBeNull();
    expect(result.regions.find((region) => region.region === 'us')!.prunedRuns).toBe(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toMatch(/Could not read Mythic\+ cutoffs: cutoffs write refused/);
    await expectInvariants(db);
  });

  it('M7.1a representation that cannot be recorded never fails the pass', async () => {
    await plantStaleRun();
    vi.spyOn(app.app.get(MplusSpecRepresentationService), 'recordLive').mockRejectedValueOnce(
      new Error('representation refused'),
    );

    const result = await pass();

    expect(result.stoppedEarly).toBeNull();
    expect(result.regions.find((region) => region.region === 'us')!.prunedRuns).toBe(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toMatch(
      /Could not record Mythic\+ spec representation: representation refused/,
    );

    // And the next pass records it: nothing was left in a state that blocks it.
    const stale = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: LIVE, region: 'all', dungeonId: null });
    await pass();
    const fresh = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: LIVE, region: 'all', dungeonId: null });
    expect(fresh!.computedAt.getTime()).toBeGreaterThan(stale!.computedAt.getTime());
  });

  it('M8.4c cutoffs that cannot be written never fail the archive tick, and the backfill heals it', async () => {
    vi.spyOn(app.app.get(MplusCatalogueRepository), 'recordCutoffs')
      .mockRejectedValueOnce(new Error('cutoffs write refused'))
      .mockRejectedValueOnce(new Error('cutoffs write refused'));

    const tick = await app.app.get(MplusArchiveService).archiveBacklog();

    expect(tick!.stoppedEarly).toBeNull();
    expect(tick!.seasons.map((season) => [season.season, season.outcome])).toEqual([
      [FINISHED, 'complete'],
    ]);
    expect((await seasonDoc(FINISHED))?.archive?.status).toBe('complete');
    expect(errors()).toHaveLength(1);
    // The same tick's backfill reads what the failure left outstanding.
    expect((await cutoffsOf(FINISHED, 'us'))?.status).toBe('ok');
    expect((await cutoffsOf(FINISHED, 'eu'))?.status).toBe('ok');
    await expectInvariants(db);
  });

  it('M7.1b representation that cannot be recorded never fails the archive tick', async () => {
    await unarchive();
    vi.spyOn(app.app.get(MplusSpecRepresentationService), 'recordArchived').mockRejectedValueOnce(
      new Error('representation refused'),
    );

    const tick = await app.app.get(MplusArchiveService).archiveBacklog();

    expect(tick!.seasons.map((season) => season.outcome)).toEqual(['complete']);
    expect((await seasonDoc(FINISHED))?.archive?.status).toBe('complete');
    expect(errors()).toHaveLength(1);
    expect(errors()[0].message).toMatch(/spec representation: representation refused/);

    // The tick's own backfill writes what the failure did not.
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .countDocuments({ season: FINISHED, source: 'archive', dungeonId: { $ne: null } }),
    ).toBeGreaterThan(0);
    await expectInvariants(db);
  });

  it('M8.5 a catalogue refresh, a marker and cutoffs landing on one document keep all three', async () => {
    await unarchive();
    const catalogue = app.app.get(MplusCatalogueService);
    let refreshing: Promise<unknown> | null = null;

    // The catalogue re-read starts as the archive reads the season's cutoffs:
    // the marker has just been written, and the cutoffs are about to be.
    app.raiderIo.beforeServe = (request) => {
      if (!refreshing && request.path === 'mythic-plus/season-cutoffs') {
        refreshing = catalogue.refresh();
      }
    };

    const before = (await seasonDoc(FINISHED))!.catalogueUpdatedAt as Date;
    await app.app.get(MplusArchiveService).archiveBacklog();
    await refreshing;

    const season = await seasonDoc(FINISHED);
    expect(refreshing, 'the refresh really did overlap the tick').not.toBeNull();
    expect((season!.catalogueUpdatedAt as Date).getTime()).toBeGreaterThan(before.getTime());
    expect(season!.dungeonIds).toHaveLength(8);
    expect(season!.archive?.status).toBe('complete');
    expect(season!.cutoffs?.us?.status).toBe('ok');
    expect(season!.cutoffs?.eu?.status).toBe('ok');
  });

  it('M7.4 recomputed figures replace the old ones, with no stale document left', async () => {
    const finishedBefore = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .find({ season: FINISHED }, { projection: { _id: 0 } })
      .sort({ region: 1, dungeonId: 1 })
      .toArray();
    const gone = WORLD_DUNGEONS[2].id;
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .countDocuments({ season: LIVE, dungeonId: gone }),
    ).toBeGreaterThan(0);

    world.removeRuns((run) => run.season === LIVE && run.dungeonId === gone);
    await pass();

    const live = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .find({ season: LIVE })
      .toArray();
    expect(live.filter((doc) => doc.dungeonId === gone)).toEqual([]);
    expect(new Set(live.map((doc) => doc.computedAt.getTime())).size, 'one computation').toBe(1);
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .find({ season: FINISHED }, { projection: { _id: 0 } })
        .sort({ region: 1, dungeonId: 1 })
        .toArray(),
      'another season is not touched',
    ).toEqual(finishedBefore);
    await expectInvariants(db);
  });

  const cutoffRequests = (region: string) =>
    app.raiderIo.requests.filter(
      (request) =>
        request.path === 'mythic-plus/season-cutoffs' &&
        request.region === region &&
        request.season === LIVE,
    );

  it('M8.2 [F3] today: three failing passes give up on a live season for good', async () => {
    app.raiderIo.failWith('season-cutoffs&region:eu', { status: 503 });
    for (let pass = 0; pass < 3; pass += 1) await app.app.get(MplusService).sweep();
    expect(await cutoffsOf(LIVE, 'eu')).toMatchObject({ status: 'unavailable', attempts: 3 });

    // Raider.io recovers; the live season is never asked again.
    app.raiderIo.reset();
    await pass();
    expect(cutoffRequests('eu')).toEqual([]);
    expect((await cutoffsOf(LIVE, 'eu'))?.status).toBe('unavailable');
  });

  // Confirmed 2026-09-25 ("expected 'unavailable' to be 'ok'"). Remove `.fails` with the fix.
  it.fails('M8.2 [F3] desired: the live season is read again once Raider.io recovers', async () => {
    await pass();

    expect((await cutoffsOf(LIVE, 'eu'))?.status).toBe('ok');
  });

  it('M8.1 [F3] today: one 404 downgrades a live season to missing, and it is never read again', async () => {
    expect((await cutoffsOf(LIVE, 'us'))?.status, 'read fine until now').toBe('ok');

    // A day Raider.io has no cutoffs for the season — the first days of a new
    // one, say. The figures read before are replaced by "missing".
    world.seasonsWithoutCutoffs.add(LIVE);
    await pass();
    const missing = await cutoffsOf(LIVE, 'us');
    expect(missing).toMatchObject({ status: 'missing', attempts: 1 });

    world.seasonsWithoutCutoffs.delete(LIVE);
    app.raiderIo.reset();
    await pass();
    expect(cutoffRequests('us'), 'never asked again while live').toEqual([]);
    expect((await cutoffsOf(LIVE, 'us'))?.status).toBe('missing');
  });

  // Confirmed 2026-09-25 ("expected 'missing' to be 'ok'"). Remove `.fails` with the fix.
  it.fails(
    'M8.1 [F3] desired: a live season recorded missing is asked again on the next pass',
    async () => {
      await pass();

      expect((await cutoffsOf(LIVE, 'us'))?.status).toBe('ok');
    },
  );

  /**
   * The partial-archive window of F7: the season has ended everywhere, the US
   * has opened its successor and Europe has not, the archive holds the US, and
   * the transition has retired the US's live rows.
   */
  const partialWindow = async () => {
    const figures = (region: string) =>
      db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION).countDocuments({ season: LIVE, region });
    await pass();
    const before = { us: await figures('us'), eu: await figures('eu') };

    if (!world.seasons.some((season) => season.slug === 'season-mn-3')) {
      world.seasons.push({
        slug: 'season-mn-3',
        name: 'MN Season 3',
        blizzardSeasonId: 19,
        isMainSeason: true,
        starts: { us: new Date(Date.now() - 60_000).toISOString(), eu: '2030-01-01T00:00:00Z' },
        ends: { us: '2030-01-01T00:00:00Z', eu: '2030-01-01T00:00:00Z' },
        dungeons: 8,
      });
    }
    await app.app.get(MplusCatalogueService).refresh();
    const us = {
      status: 'complete',
      pagesFetched: 5,
      failedPages: [],
      runs: 30,
      characters: 1,
      archivedAt: new Date(),
      source: 'fetched',
    };
    await db.collection(MPLUS_SEASONS_COLLECTION).updateOne(
      { slug: LIVE },
      {
        $set: {
          archive: {
            status: 'partial',
            pagesPlanned: 3,
            pagesFetched: 5,
            failedPages: [],
            runs: 30,
            characters: 1,
            regions: { us },
            archivedAt: new Date(),
            source: 'fetched',
          },
        },
      },
    );
    await db.collection(MPLUS_RUNS_COLLECTION).deleteMany({ season: LIVE, region: 'us' });
    await db.collection(MPLUS_CHARACTERS_COLLECTION).deleteMany({ season: LIVE, region: 'us' });

    const result = await pass();
    expect(result.seasons).toEqual({ us: 'season-mn-3', eu: LIVE });

    return { before, after: { us: await figures('us'), eu: await figures('eu') } };
  };

  // Set up once and shared: a second setup would start from the first's result.
  let window: Awaited<ReturnType<typeof partialWindow>> | undefined;
  const partial = async () => (window ??= await partialWindow());

  it('M7.2 [F7] today: the live pass rewrites a partly archived season from one region', async () => {
    const { before, after } = await partial();

    expect(before.us).toBeGreaterThan(0);
    expect(after.us, 'the US documents are deleted').toBe(0);
    expect(after.eu).toBe(before.eu);
    const all = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: LIVE, region: 'all', dungeonId: null });
    const eu = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: LIVE, region: 'eu', dungeonId: null });
    expect(all!.runs, '"all" is now Europe alone').toBe(eu!.runs);
  });

  // Confirmed 2026-09-25 ("expected +0 to be 3"). Remove `.fails` with the fix.
  it.fails(
    'M7.2 [F7] desired: the regions the live pass did not read keep their figures',
    async () => {
      const { before, after } = await partial();

      expect(after.us).toBe(before.us);
    },
  );
});
