import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MplusSpecRepresentationService } from '../src/mplus-representation/mplus-spec-representation.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusArchiveMarkersMatchRows,
  expectMplusArchiveRowsOwned,
} from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const GROWN = 'season-mn-1';
const PARTIAL = 'season-tww-3';
const DEAD = 'season-sl-4';

/**
 * M6.2 / M6.6 — the archive when the regions it holds and the regions it is
 * configured for differ (gap §7.7, A5).
 *
 * The file's configuration is the later one, two regions. The earlier states —
 * a season archived while only the US was configured, a season a tick left
 * half-done — are made by archiving for real and then taking Europe back out of
 * the marker, which is exactly what those states look like on disk.
 */
describe('Mythic+ archive across region changes', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();
  const logger = new CapturingLogger();

  type RegionMarker = { status: string; runs: number; archivedAt: Date; source: string };
  const marker = async (slug: string) =>
    (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug }))?.archive as
      | { status: string; runs: number; characters: number; regions: Record<string, RegionMarker> }
      | undefined;
  const runsRequests = (season: string) =>
    app.raiderIo.requests.filter(
      (request) => request.path === 'mythic-plus/runs' && request.season === season,
    );

  /** Takes a region back out of a season's archive: marker, rows and figures. */
  const forgetRegion = async (slug: string, region: string, status: string) => {
    const archive = (await marker(slug))!;
    const kept = Object.fromEntries(
      Object.entries(archive.regions).filter(([name]) => name !== region),
    );
    await db.collection(MPLUS_SEASONS_COLLECTION).updateOne(
      { slug },
      {
        $set: {
          'archive.status': status,
          'archive.regions': kept,
          'archive.runs': Object.values(kept).reduce((sum, entry) => sum + entry.runs, 0),
          'archive.characters': await db
            .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
            .countDocuments({ season: slug, region: { $ne: region } }),
        },
        $unset: { [`cutoffs.${region}`]: '' },
      },
    );
  };

  beforeAll(async () => {
    world.seasons.push({
      slug: DEAD,
      name: 'SL Season 4',
      blizzardSeasonId: 8,
      isMainSeason: true,
      starts: { us: '2022-08-02T15:00:00Z' },
      ends: { us: '2022-10-25T15:00:00Z', eu: '2022-10-26T04:00:00Z' },
      dungeons: 8,
    });
    world.seasons.push({
      slug: PARTIAL,
      name: 'TWW Season 3',
      blizzardSeasonId: 15,
      isMainSeason: true,
      starts: { us: '2025-08-12T15:00:00Z' },
      ends: { us: '2026-03-02T22:00:00Z', eu: '2026-03-03T04:00:00Z' },
      dungeons: 8,
    });
    world
      .seed('us', 60, 600, GROWN)
      .seed('eu', 30, 590, GROWN)
      .seed('us', 40, 550, PARTIAL)
      // Deeper than three pages, so Europe's stored rows are exactly a full read.
      .seed('eu', 80, 540, PARTIAL)
      .seed('us', 60, 400, DEAD)
      .seed('eu', 60, 390, DEAD);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us,eu' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;

    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    expect(tick!.seasons.map((season) => season.outcome)).toEqual([
      'complete',
      'complete',
      'complete',
    ]);
    app.raiderIo.reset();
  });

  afterEach(() => {
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M6.2 a region added to RAIDERIO_REGIONS later is read on its own', async () => {
    // As a US-only deployment left it: complete, with no Europe at all.
    await forgetRegion(GROWN, 'eu', 'complete');
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: GROWN, region: 'eu' });
    await db
      .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
      .deleteMany({ season: GROWN, region: 'eu' });
    const season = await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: GROWN });
    await app.app
      .get(MplusSpecRepresentationService)
      .recordArchived(
        season as unknown as Parameters<MplusSpecRepresentationService['recordArchived']>[0],
      );
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .distinct('region', { season: GROWN }),
    ).toEqual(['all', 'us']);
    await expectMplusArchiveMarkersMatchRows(db);
    const usBefore = (await marker(GROWN))!.regions.us;

    const tick = await app.app.get(MplusArchiveService).archiveBacklog();

    expect(tick!.seasons.map((entry) => [entry.season, entry.regions])).toEqual([[GROWN, ['eu']]]);
    expect(runsRequests(GROWN).every((request) => request.region === 'eu')).toBe(true);
    expect(runsRequests(GROWN).length).toBeGreaterThan(0);

    const after = (await marker(GROWN))!;
    expect(after.status).toBe('complete');
    expect(after.regions.eu).toMatchObject({ status: 'complete', runs: 30 });
    expect(after.regions.us.archivedAt, 'the US is kept exactly as it was').toEqual(
      usBefore.archivedAt,
    );

    // The figures are rewritten over both regions, and only Europe's cutoffs read.
    const all = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: GROWN, region: 'all', dungeonId: null });
    expect(all!.runs).toBe(90);
    expect(
      app.raiderIo.requests
        .filter((request) => request.path === 'mythic-plus/season-cutoffs')
        .map((request) => `${request.region}:${request.season}`),
    ).toEqual([`eu:${GROWN}`]);

    await expectMplusArchiveMarkersMatchRows(db);
    await expectMplusArchiveRowsOwned(db);
    await expectInvariants(db);
  });

  it('M6.6 a marker missing only one region refetches it rather than adopting its rows', async () => {
    // A tick that finished the US and was interrupted after writing all of
    // Europe's rows but before recording it.
    await forgetRegion(PARTIAL, 'eu', 'partial');
    expect(
      await db
        .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
        .countDocuments({ season: PARTIAL, region: 'eu' }),
      'exactly a full read',
    ).toBe(60);

    await app.app.get(MplusArchiveService).archiveBacklog();

    // Adoption is only for a season with no marker at all: a marker that exists
    // is an explicit record, and a region it lacks was never finished.
    expect(runsRequests(PARTIAL).map((request) => `${request.region}:${request.page}`)).toEqual([
      'eu:0',
      'eu:1',
      'eu:2',
    ]);
    const after = (await marker(PARTIAL))!;
    expect(after.status).toBe('complete');
    expect(after.regions.eu).toMatchObject({ status: 'complete', source: 'fetched', runs: 60 });
    await expectMplusArchiveMarkersMatchRows(db);
    await expectInvariants(db);
  });

  /**
   * F4's state: a tick finished the US and left a partial marker, and on the
   * next tick Europe's page 1 answers 404. Set up once and shared, since the
   * archive does not run a season twice.
   */
  let deadEnd: { usRows: number; marker: Awaited<ReturnType<typeof marker>> } | undefined;
  const reachDeadEnd = async () => {
    if (deadEnd) return deadEnd;

    await forgetRegion(DEAD, 'eu', 'partial');
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: DEAD, region: 'eu' });
    await db
      .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
      .deleteMany({ season: DEAD, region: 'eu' });
    app.raiderIo.failWith(`mythic-plus/runs&season:${DEAD}&region:eu&page:1`, { status: 404 });

    await app.app.get(MplusArchiveService).archiveBacklog();

    deadEnd = {
      usRows: await db
        .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
        .countDocuments({ season: DEAD, region: 'us' }),
      marker: await marker(DEAD),
    };

    return deadEnd;
  };

  it('M6.1 [F4] a 404 after a region was read keeps it, and leaves only the failing region to retry', async () => {
    const { usRows, marker: after } = await reachDeadEnd();

    expect(after!.status).toBe('incomplete');
    expect(after!.regions.us, 'the US read earlier is kept').toMatchObject({
      status: 'complete',
      runs: 60,
    });
    expect(after!.regions.eu).toMatchObject({ status: 'incomplete', failedPages: [1] });
    expect(usRows).toBe(60);
    await expectMplusArchiveRowsOwned(db);

    // Not settled in Europe, so the transition does not treat it as held there;
    // and the next tick reads Europe again rather than giving up on the season.
    app.raiderIo.reset();
    await app.app.get(MplusArchiveService).archiveBacklog();
    expect((await marker(DEAD))!.status).toBe('complete');
    expect(runsRequests(DEAD).every((request) => request.region === 'eu')).toBe(true);
    await expectMplusArchiveMarkersMatchRows(db);
    await expectMplusArchiveRowsOwned(db);
  });

  it('M6.1 [F4] a region whose first page 404s is incomplete, not the season, once another is held', async () => {
    // Back to "the US held, Europe owed", and this time Europe's whole board 404s.
    await forgetRegion(DEAD, 'eu', 'partial');
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: DEAD, region: 'eu' });
    await db
      .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
      .deleteMany({ season: DEAD, region: 'eu' });
    app.raiderIo.failWith(`mythic-plus/runs&season:${DEAD}&region:eu`, { status: 404 });

    await app.app.get(MplusArchiveService).archiveBacklog();

    const after = (await marker(DEAD))!;
    expect(after.status).toBe('incomplete');
    expect(after.regions.us.status).toBe('complete');
    expect(after.regions.eu).toMatchObject({ status: 'incomplete', runs: 0 });
    expect(
      logger.of('warn', /answered 404 after other regions were read/),
      'said, rather than calling the season unarchivable',
    ).toHaveLength(1);
    await expectMplusArchiveRowsOwned(db);

    app.raiderIo.reset();
    await app.app.get(MplusArchiveService).archiveBacklog();
    expect((await marker(DEAD))!.status).toBe('complete');
  });

  /** Rows for a season no expansion lists, as a renamed or dropped slug leaves them. */
  const leftover = async () => {
    const [run] = await db
      .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
      .find({ season: GROWN, region: 'us' }, { projection: { _id: 0 } })
      .limit(1)
      .toArray();
    const [character] = await db
      .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
      .find(
        { season: GROWN, region: 'us', key: { $in: run.rosterKeys } },
        { projection: { _id: 0 } },
      )
      .limit(1)
      .toArray();
    await db.collection(MPLUS_RUNS_COLLECTION).insertOne({ ...run, season: 'season-legacy' });
    await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .insertOne({ ...character, season: 'season-legacy' });
  };

  it('M5.5 [F5] an uncatalogued leftover is retired under the default interlock', async () => {
    await leftover();

    const { plan, purged } = await app.app.get(MplusSeasonTransitionService).run();

    expect(plan.requireArchive, 'the default interlock').toBe(true);
    expect(plan.blockedByArchive).toEqual([]);
    expect(purged.map((entry) => `${entry.season}/${entry.region}`)).toContain('season-legacy/us');
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-legacy' }),
    ).toBe(0);
    expect(logger.of('warn', /Holding back/)).toEqual([]);
  });
});
