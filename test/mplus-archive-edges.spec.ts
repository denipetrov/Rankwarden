import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MplusSpecRepresentationService } from '../src/mplus-representation/mplus-spec-representation.service.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { MplusCutoffsService } from '../src/mplus-season/mplus-cutoffs.service.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusArchiveMarkersMatchRows,
  expectMplusArchiveRowsOwned,
} from './support/invariants.js';
import { MplusWorld, type MplusWorldSeason } from './support/mplus-world.js';
import { World } from './support/world.js';

const DROPPED = 'season-mn-1';
const EMPTY = 'season-tww-1';
const MOVED = 'season-tww-2';
const SHALLOW = 'season-tww-3';

/**
 * M6.3-M6.5, M6.7 — the archive against configuration changes and upstream
 * corrections it does not otherwise meet (gap §7.7).
 *
 * One region configured, the US, and five pages archived. The states each case
 * needs are made by archiving for real and then editing what is on disk into
 * what an earlier configuration would have left.
 */
describe('Mythic+ archive edges', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  const seasonDoc = (slug: string) => db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug });
  const runsRequests = (season: string) =>
    app.raiderIo.requests.filter(
      (request) => request.path === 'mythic-plus/runs' && request.season === season,
    );
  const tick = () => app.app.get(MplusArchiveService).archiveBacklog();

  const finished = (slug: string, endedDaysAgo: number): MplusWorldSeason => ({
    slug,
    name: slug,
    blizzardSeasonId: null,
    isMainSeason: true,
    starts: { us: new Date(Date.now() - (endedDaysAgo + 120) * 86_400_000).toISOString() },
    ends: { us: new Date(Date.now() - endedDaysAgo * 86_400_000).toISOString() },
    dungeons: 8,
  });

  beforeAll(async () => {
    world.seasons.push(finished(EMPTY, 400), finished(MOVED, 300), finished(SHALLOW, 250));
    world
      .seed('us', 40, 600, DROPPED)
      .seed('us', 30, 500, MOVED)
      // Exactly three pages: archived at three, it is a full read.
      .seed('us', 60, 450, SHALLOW);
    // EMPTY has no runs at all: every page answers `rankings: []`.

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_ARCHIVE_PAGES: '5' },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;

    const first = await tick();
    expect(first!.seasons.every((season) => season.outcome === 'complete')).toBe(true);
    app.raiderIo.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app.raiderIo.reset();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M6.3 a region dropped from the configuration does not hold a season open — but the readers disagree', async () => {
    // What a US+Europe deployment left behind: the US complete, Europe not, and
    // some of Europe's rows. This deployment configures the US alone.
    const archive = (await seasonDoc(DROPPED))!.archive;
    await db.collection(MPLUS_SEASONS_COLLECTION).updateOne(
      { slug: DROPPED },
      {
        $set: {
          'archive.status': 'incomplete',
          'archive.regions.eu': {
            status: 'incomplete',
            pagesFetched: 1,
            failedPages: [1],
            runs: 0,
            characters: 0,
            archivedAt: new Date(),
            source: 'fetched',
          },
          'archive.failedPages': ['eu:1'],
        },
      },
    );

    await tick();

    // Not owed: judged over the configured regions only.
    expect(runsRequests(DROPPED)).toEqual([]);
    // But nothing rewrites the marker, so its stored status stays what the old
    // configuration left.
    expect((await seasonDoc(DROPPED))!.archive.status).toBe('incomplete');
    expect((await seasonDoc(DROPPED))!.archive.regions.us).toEqual(archive.regions.us);

    // The readers disagree about it. Representation judges by the regions
    // owed, so it counts the season as archived and leaves it alone...
    expect(await app.app.get(MplusSpecRepresentationService).recordLive([DROPPED])).toBe(0);
    // ...while the cutoffs judge by `status === 'complete'`: a live read would
    // ask again, and the archive's backfill never looks at it.
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: DROPPED }, { $unset: { 'cutoffs.us': '' } });
    await tick();
    expect(
      app.raiderIo.countMatching('season-cutoffs'),
      'the backfill skips a season whose status is not complete',
    ).toBe(0);
    expect(await app.app.get(MplusCutoffsService).recordLive(new Map([['us', DROPPED]]))).toBe(1);

    await expectMplusArchiveRowsOwned(db);
    await expectInvariants(db);
  });

  it('M6.4 a season with no runs anywhere is complete, with no figures — recomputed on every tick', async () => {
    const empty = (await seasonDoc(EMPTY))!;
    expect(empty.archive).toMatchObject({ status: 'complete', runs: 0, characters: 0 });
    expect(empty.archive.regions.us).toMatchObject({ status: 'complete', runs: 0 });
    // No document rather than an empty one: "nothing was read", not "no spec was played".
    expect(
      await db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION).countDocuments({ season: EMPTY }),
    ).toBe(0);
    // Cutoffs are Raider.io's figure, not ours, so they are read regardless.
    expect(empty.cutoffs?.us?.status).toBe('ok');

    // The backfill looks for a per-dungeon document, never finds one, and so
    // recomputes this season on every tick. Harmless — only the database — but
    // it never ends. Pinned as it is.
    const recordArchived = vi.spyOn(app.app.get(MplusSpecRepresentationService), 'recordArchived');
    await tick();
    await tick();
    expect(recordArchived.mock.calls.filter(([season]) => season.slug === EMPTY)).toHaveLength(2);
    expect(app.raiderIo.countMatching('mythic-plus/runs'), 'and never refetched').toBe(0);
  });

  it("M6.5 a season's end moving back to the 2030 placeholder does not undo its archive", async () => {
    const before = (await seasonDoc(MOVED))!;
    expect(before.archive.status).toBe('complete');

    // An upstream correction puts the placeholder back.
    world.seasons.find((season) => season.slug === MOVED)!.ends = { us: '2030-01-01T00:00:00Z' };
    await app.app.get(MplusCatalogueService).refresh();
    const planBefore = await app.app.get(MplusSeasonTransitionService).plan();

    await tick();

    const after = (await seasonDoc(MOVED))!;
    expect(after.ends.us.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    // The refresh writes its own fields and leaves the marker alone (C5); the
    // marker, not the dates, is what says a season is held.
    expect(after.archive).toEqual(before.archive);
    expect(runsRequests(MOVED)).toEqual([]);
    expect(await app.app.get(MplusSeasonTransitionService).plan()).toEqual(planBefore);
    await expectMplusArchiveMarkersMatchRows(db);
  });

  it('M6.7 raising MPLUS_ARCHIVE_PAGES does not re-archive a completed season', async () => {
    // As a three-page deployment recorded it. Its rows are a full three pages.
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne(
        { slug: SHALLOW },
        { $set: { 'archive.pagesPlanned': 3, 'archive.regions.us.pagesFetched': 3 } },
      );
    expect(
      await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments({ season: SHALLOW }),
    ).toBe(60);

    await tick();

    // Deepening history needs the marker cleared by hand: a complete region is
    // never read again, whatever the configuration now says.
    expect(runsRequests(SHALLOW)).toEqual([]);
    expect((await seasonDoc(SHALLOW))!.archive.pagesPlanned).toBe(3);
    expect(
      await db.collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION).countDocuments({ season: SHALLOW }),
    ).toBe((await seasonDoc(SHALLOW))!.archive.characters);
    await expectMplusArchiveMarkersMatchRows(db);
    await expectInvariants(db);
  });
});
