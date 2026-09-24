import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { QuotaBudget } from '../src/common/quota/quota-budget.service.js';
import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_AFFIXES_COLLECTION } from '../src/mplus/entities/mplus-affix.entity.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import {
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * The Mythic+ archive of finished seasons, driven by hand.
 *
 * The world holds three expansions: Dragonflight (9), The War Within (10) and
 * Midnight (11), over two regions. Each finished main season has its own board
 * per region, read region by region as the live pass reads them; a side event
 * and the running season are there to be left alone.
 */
describe('Mythic+ archive', () => {
  let app: TestApp;
  let archive: MplusArchiveService;
  let catalogue: MplusCatalogueService;
  let coordinator: IngestionCoordinator;
  let db: Db;
  const world = new MplusWorld();

  const runsRequestsFor = (season: string, region?: string) =>
    app.raiderIo.requests.filter(
      (request) =>
        request.path === 'mythic-plus/runs' &&
        request.season === season &&
        (region === undefined || request.region === region),
    ).length;

  interface RegionMarker {
    status: string;
    runs: number;
    characters: number;
    source: string;
    failedPages: number[];
  }

  const marker = async (slug: string) =>
    (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug }))?.archive as
      | {
          status: string;
          runs: number;
          characters: number;
          source: string;
          failedPages: string[];
          regions: Record<string, RegionMarker>;
        }
      | undefined;

  beforeAll(async () => {
    world.seasons.push(
      {
        slug: 'season-tww-3',
        name: 'TWW Season 3',
        blizzardSeasonId: 15,
        isMainSeason: true,
        expansionId: 10,
        starts: { us: '2025-08-12T15:00:00Z' },
        ends: { us: '2026-03-02T22:00:00Z', eu: '2026-03-03T04:00:00Z' },
        dungeons: 8,
        firstDungeonId: 9_500,
      },
      {
        slug: 'season-tww-3-break-the-meta',
        name: 'Break the Meta',
        blizzardSeasonId: 15,
        isMainSeason: false,
        expansionId: 10,
        starts: { us: '2025-11-18T15:00:00Z' },
        ends: { us: '2025-11-25T15:00:00Z' },
        dungeons: 8,
      },
      {
        slug: 'season-df-4',
        name: 'DF Season 4',
        blizzardSeasonId: 12,
        isMainSeason: true,
        expansionId: 9,
        starts: { us: '2024-04-23T15:00:00Z' },
        ends: { us: '2024-08-26T22:00:00Z' },
        dungeons: 8,
        // Shares half its dungeons with TWW, as real seasons do.
        firstDungeonId: 9_504,
      },
    );

    // Three pages is a full read at MPLUS_ARCHIVE_PAGES=3: 60 runs a region.
    // TWW 3's US board is deeper than that and its EU board shallower, so one
    // season shows both the page limit and a board that ends first.
    world
      .seed('us', 40, 600, 'season-mn-1')
      .seed('eu', 30, 590, 'season-mn-1')
      .seed('us', 80, 550, 'season-tww-3')
      .seed('eu', 30, 540, 'season-tww-3')
      .seed('us', 40, 500, 'season-tww-3-break-the-meta')
      // A board shallower than the page limit, ending on page 1 — and no EU
      // board at all, as Legion and BfA have none in China.
      .seed('us', 20, 450, 'season-df-4')
      // The running season, for the live pass.
      .seed('us', 20, 400, 'season-mn-2');

    // Affixes rotated weekly in older seasons, so one board carries several
    // sets — season-sl-4's real world board has ten across its top 2,000 runs.
    // Mirrored on DF4, with affixes the live season never shows.
    const rotation = [
      [
        { id: 10, name: 'Fortified', slug: 'fortified' },
        { id: 123, name: 'Spiteful', slug: 'spiteful' },
        { id: 4, name: 'Necrotic', slug: 'necrotic' },
      ],
      [
        { id: 9, name: 'Tyrannical', slug: 'tyrannical' },
        { id: 11, name: 'Bursting', slug: 'bursting' },
        { id: 3, name: 'Volcanic', slug: 'volcanic' },
      ],
      [
        { id: 10, name: 'Fortified', slug: 'fortified' },
        { id: 7, name: 'Bolstering', slug: 'bolstering' },
        { id: 14, name: 'Quaking', slug: 'quaking' },
      ],
    ];
    world.runs
      .filter((run) => run.season === 'season-df-4')
      .forEach((run, index) => {
        run.affixes = rotation[index % rotation.length];
      });

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        RAIDERIO_REGIONS: 'us,eu',
        // One page a batch, so the archive re-checks priority between pages.
        RAIDERIO_PAGE_BATCH: '1',
        MPLUS_CATALOGUE_FIRST_EXPANSION: '9',
      },
      undefined,
      undefined,
      world,
    );
    archive = app.app.get(MplusArchiveService);
    catalogue = app.app.get(MplusCatalogueService);
    coordinator = app.app.get(IngestionCoordinator);
    db = app.app.get(MongoService).db;
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    app.raiderIo.reset();
  });

  it('builds the catalogue by walking expansions until one lists no seasons', async () => {
    await archive.archiveBacklog();

    const staticRequests = app.raiderIo.requests.filter(
      (request) => request.path === 'mythic-plus/static-data',
    );
    // 9, 10 and 11 answer with seasons; 12 answers with none and ends the walk.
    expect(staticRequests).toHaveLength(4);

    const slugs = (await db.collection(MPLUS_SEASONS_COLLECTION).find({}).toArray())
      .map((season) => season.slug)
      .sort();
    // Main seasons only. The two break-the-meta weeks are listed by Raider.io
    // and never stored: nothing is archived for them, so an entry would describe
    // data the database does not have.
    expect(slugs).toEqual(['season-df-4', 'season-mn-1', 'season-mn-2', 'season-tww-3']);
    // Asserted here, where the tick ran, rather than after the request log resets.
    expect(runsRequestsFor('season-tww-3-break-the-meta'), 'nor fetched').toBe(0);
  });

  it('stores each dungeon once, with every expansion that ran it', async () => {
    const shared = await db.collection(MPLUS_DUNGEONS_COLLECTION).findOne({ id: 9_505 });

    // 9505 is in both DF 4 (9504-9511) and TWW 3 / Midnight (9500-9507).
    expect(shared).not.toBeNull();
    expect((shared!.expansionIds as number[]).sort((left, right) => left - right)).toEqual([
      9, 10, 11,
    ]);
    expect(await db.collection(MPLUS_DUNGEONS_COLLECTION).countDocuments({ id: 9_505 })).toBe(1);
  });

  it('archives finished main seasons, and leaves side events and the running season', async () => {
    expect((await marker('season-mn-1'))?.status).toBe('complete');
    expect((await marker('season-tww-3'))?.status).toBe('complete');
    expect((await marker('season-df-4'))?.status).toBe('complete');

    expect(
      await db.collection(MPLUS_SEASONS_COLLECTION).countDocuments({ slug: /break-the-meta/ }),
      'a side event is not even catalogued',
    ).toBe(0);
    expect(await marker('season-mn-2'), 'the running season').toBeUndefined();
    expect(
      await db
        .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
        .countDocuments({ season: { $in: ['season-mn-2', 'season-tww-3-break-the-meta'] } }),
    ).toBe(0);
  });

  it("reads each region's own board, to the configured depth", async () => {
    const tww3 = await marker('season-tww-3');

    // 80 runs on the US board, 3 pages x 20 archived; 30 on the EU board, all.
    expect(tww3?.regions.us.runs).toBe(60);
    expect(tww3?.regions.eu.runs).toBe(30);
    expect(tww3?.runs).toBe(90);
    expect(
      await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments({ season: 'season-tww-3' }),
    ).toBe(90);

    // Ranks are each region's own, as the live board's are — the point of
    // reading per region.
    const topRanks = await db
      .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
      .find({ season: 'season-tww-3', rank: 1 })
      .toArray();
    expect(topRanks.map((run) => run.region).sort()).toEqual(['eu', 'us']);
  });

  it('never asks for the world board', async () => {
    // The fake answers `world` with a 404, so a request for it would also have
    // marked a season unarchivable; asserting the request itself is clearer.
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-df-4' }, { $unset: { archive: '' } });
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: 'season-df-4' });

    await archive.archiveBacklog();

    expect(app.raiderIo.requests.filter((request) => request.region === 'world')).toEqual([]);
    expect(runsRequestsFor('season-df-4', 'us')).toBeGreaterThan(0);
    expect(runsRequestsFor('season-df-4', 'eu')).toBeGreaterThan(0);
  });

  it('treats a board shorter than the page limit, or none at all, as complete', async () => {
    const df4 = await marker('season-df-4');

    expect(df4?.status).toBe('complete');
    expect(df4?.regions.us).toMatchObject({ status: 'complete', runs: 20, failedPages: [] });
    // No EU board: page 0 answers with no rankings, which ends the region.
    expect(df4?.regions.eu).toMatchObject({ status: 'complete', runs: 0, pagesFetched: 1 });
  });

  it("keeps each run's own affixes and adds every one to the affix collection", async () => {
    const runs = await db
      .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
      .find({ season: 'season-df-4' })
      .toArray();
    const sets = new Set(runs.map((run) => (run.affixIds as number[]).join(',')));

    // Three weekly sets on one board, each stored on the run that carried it
    // rather than flattened to one season-wide set.
    expect([...sets].sort()).toEqual(['10,123,4', '10,7,14', '9,11,3']);

    const affixes = await db
      .collection(MPLUS_AFFIXES_COLLECTION)
      .find({ id: { $in: [3, 4, 7, 11, 14, 123] } })
      .toArray();
    expect(
      affixes.map((affix) => affix.name).sort(),
      'every affix only an old season ran is referenceable',
    ).toEqual(['Bolstering', 'Bursting', 'Necrotic', 'Quaking', 'Spiteful', 'Volcanic']);
    expect(affixes.every((affix) => affix.description && affix.icon)).toBe(true);
  });

  it('files each run and character under the region whose board it came from', async () => {
    const regions = (await db
      .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
      .distinct('region', { season: 'season-tww-3' })) as string[];
    expect(regions.sort()).toEqual(['eu', 'us']);

    const characterRegions = (await db
      .collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)
      .distinct('region', { season: 'season-tww-3' })) as string[];
    expect(characterRegions.sort()).toEqual(['eu', 'us']);

    expect(
      await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments({ region: 'world' }),
    ).toBe(0);
  });

  it('keeps archived data out of the live collections', async () => {
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments()).toBe(0);
    expect(await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments()).toBe(0);
  });

  it('archives a season once: a second tick fetches nothing', async () => {
    const result = await archive.archiveBacklog();

    expect(result!.seasons).toEqual([]);
    expect(result!.pending).toBe(0);
    expect(result!.catalogue.refreshed, 'the catalogue is inside its TTL').toBe(false);
    expect(app.raiderIo.requests, 'not one request').toEqual([]);
  });

  it('keeps every archive marker through a catalogue refresh', async () => {
    // The catalogue and the markers share a document. A refresh that replaced
    // the document would erase every marker, and the next tick would quietly
    // fetch the whole archive again — "once" would stop being true with nothing
    // reporting it.
    await catalogue.refresh();
    app.raiderIo.reset();

    expect((await marker('season-tww-3'))?.status).toBe('complete');

    await archive.archiveBacklog();
    expect(
      app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/runs'),
      'nothing refetched',
    ).toEqual([]);
  });

  it('charges its requests to the archive, not to the live pass or to Blizzard', async () => {
    const budget = app.app.get(RaiderIoBudget);
    const before = budget.spent('mplusArchive');

    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-df-4' }, { $unset: { archive: '' } });
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: 'season-df-4' });
    await archive.archiveBacklog();

    expect(budget.spent('mplusArchive')).toBeGreaterThan(before);
    expect(app.app.get(QuotaBudget).spent('archive'), "Blizzard's archive share").toBe(0);
  });

  it('adopts a region whose rows prove a full read, and refetches one whose rows do not', async () => {
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-tww-3' }, { $unset: { archive: '' } });

    const result = await archive.archiveBacklog();

    // The US holds exactly a full read (60). Europe holds 30, which a board
    // that ended early and a fetch that died halfway would both leave, so it is
    // read again rather than trusted.
    expect(result!.seasons.map((season) => [season.season, season.outcome])).toEqual([
      ['season-tww-3', 'complete'],
    ]);
    expect(runsRequestsFor('season-tww-3', 'us'), 'the US recovered without refetching').toBe(0);
    expect(runsRequestsFor('season-tww-3', 'eu')).toBeGreaterThan(0);

    const tww3 = await marker('season-tww-3');
    expect(tww3?.regions.us.source).toBe('adopted');
    expect(tww3?.regions.eu.source).toBe('fetched');
    expect(tww3?.status).toBe('complete');
  });

  it('refetches a season whose rows are ambiguous rather than trust them', async () => {
    // Half a season and no marker: a fetch that died partway looks exactly like
    // this. Adopting it would make the gap permanent.
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-mn-1' }, { $unset: { archive: '' } });
    await db
      .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
      .deleteMany({ season: 'season-mn-1', score: { $lt: 580 } });

    await archive.archiveBacklog();

    expect(runsRequestsFor('season-mn-1')).toBeGreaterThan(0);
    const mn1 = await marker('season-mn-1');
    expect(mn1?.status).toBe('complete');
    expect(mn1?.source).toBe('fetched');
    expect(mn1?.runs).toBe(70);
  });

  it('marks a season incomplete on a failed page, and retries it on a later tick', async () => {
    world.seasons.push({
      slug: 'season-tww-2',
      name: 'TWW Season 2',
      blizzardSeasonId: 14,
      isMainSeason: true,
      expansionId: 10,
      starts: { us: '2025-03-04T15:00:00Z' },
      ends: { us: '2025-08-12T15:00:00Z' },
      dungeons: 8,
    });
    world.seed('us', 60, 530, 'season-tww-2');
    await catalogue.refresh();

    app.raiderIo.failWith('mythic-plus/runs', { status: 500, times: 1 });
    const first = await archive.archiveBacklog();

    expect(first!.seasons.find((season) => season.season === 'season-tww-2')?.outcome).toBe(
      'incomplete',
    );
    const failed = await marker('season-tww-2');
    expect(failed?.status).toBe('incomplete');
    // The US's first page failed; Europe, with no board, was read cleanly.
    expect(failed?.failedPages).toEqual(['us:0']);
    expect(failed?.regions.eu.status).toBe('complete');
    expect(first!.pending, 'still owed').toBe(1);
    // Set aside for the rest of that tick, not retried in a loop: three US
    // pages and the one EU page that ended its board.
    expect(runsRequestsFor('season-tww-2')).toBe(4);

    app.raiderIo.reset();
    await archive.archiveBacklog();

    expect((await marker('season-tww-2'))?.status).toBe('complete');
    // Only the region that failed is read again.
    expect(runsRequestsFor('season-tww-2', 'us')).toBe(3);
    expect(runsRequestsFor('season-tww-2', 'eu')).toBe(0);
  });

  it('marks a season Raider.io will not serve as unarchivable, and never asks again', async () => {
    world.seasons.push({
      slug: 'season-tww-1',
      name: 'TWW Season 1',
      blizzardSeasonId: 13,
      isMainSeason: true,
      expansionId: 10,
      starts: { us: '2024-09-17T15:00:00Z' },
      ends: { us: '2025-02-25T15:00:00Z' },
      dungeons: 8,
    });
    world.unservedSeasons.add('season-tww-1');
    await catalogue.refresh();
    app.raiderIo.reset();

    await archive.archiveBacklog();
    expect((await marker('season-tww-1'))?.status).toBe('unarchivable');

    app.raiderIo.reset();
    await archive.archiveBacklog();
    expect(runsRequestsFor('season-tww-1')).toBe(0);
  });

  it('does not start while any other job is running, the PvP archive included', async () => {
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-df-4' }, { $unset: { archive: '' } });
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: 'season-df-4' });

    for (const [name, during] of [
      ['sweep', (work: () => Promise<unknown>) => coordinator.duringSweep(work)],
      ['enrichment', (work: () => Promise<unknown>) => coordinator.duringEnrichment(work)],
      ['live M+ pass', (work: () => Promise<unknown>) => coordinator.duringMplus(work)],
      ['PvP archive', (work: () => Promise<unknown>) => coordinator.duringArchive(work)],
    ] as const) {
      app.raiderIo.reset();

      const result = (await during(() => archive.archiveBacklog())) as Awaited<
        ReturnType<MplusArchiveService['archiveBacklog']>
      >;

      expect(result!.stoppedEarly, `yields to the ${name}`).not.toBeNull();
      expect(runsRequestsFor('season-df-4'), `no fetch under the ${name}`).toBe(0);
    }
  });

  it('yields mid-region when a higher-priority job starts, leaving no marker', async () => {
    let release!: () => void;
    let sweep: Promise<unknown> | undefined;

    // Start a sweep the moment the first page of the season is requested, and
    // hold it open.
    app.raiderIo.beforeServe = (request) => {
      if (request.season === 'season-df-4' && !sweep) {
        sweep = coordinator.duringSweep(() => new Promise<void>((resolve) => (release = resolve)));
      }
    };

    const result = await archive.archiveBacklog();

    expect(result!.seasons.find((season) => season.season === 'season-df-4')?.outcome).toBe(
      'yielded',
    );
    expect(runsRequestsFor('season-df-4'), 'stopped after the page in flight').toBe(1);
    // No marker: nothing failed, so nothing should claim a failure.
    expect(await marker('season-df-4')).toBeUndefined();

    release();
    await sweep;
    app.raiderIo.reset();

    await archive.archiveBacklog();
    expect((await marker('season-df-4'))?.status).toBe('complete');
  });

  it('keeps its regions read when interrupted between regions, and reads only the rest', async () => {
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-df-4' }, { $unset: { archive: '' } });
    await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).deleteMany({ season: 'season-df-4' });

    let release!: () => void;
    let sweep: Promise<unknown> | undefined;

    // The sweep starts on the US's last page — the empty one that ends its
    // board — so the US finishes and Europe is next when the archive checks.
    app.raiderIo.beforeServe = (request) => {
      if (
        request.season === 'season-df-4' &&
        request.region === 'us' &&
        request.page === 1 &&
        !sweep
      ) {
        sweep = coordinator.duringSweep(() => new Promise<void>((resolve) => (release = resolve)));
      }
    };

    const result = await archive.archiveBacklog();
    expect(result!.seasons.find((season) => season.season === 'season-df-4')?.outcome).toBe(
      'yielded',
    );

    // Nothing failed, so nothing claims a failure — but the US is kept.
    const partial = await marker('season-df-4');
    expect(partial?.status).toBe('partial');
    expect(partial?.regions.us.status).toBe('complete');
    expect(partial?.regions.eu).toBeUndefined();

    release();
    await sweep;
    app.raiderIo.reset();

    await archive.archiveBacklog();
    expect((await marker('season-df-4'))?.status).toBe('complete');
    expect(runsRequestsFor('season-df-4', 'us'), 'the US is not read again').toBe(0);
    expect(runsRequestsFor('season-df-4', 'eu')).toBeGreaterThan(0);
  });

  it('re-reads a season archived from the world board, region by region', async () => {
    // A marker from the earlier archive: complete, but with no regions. It says
    // nothing about any one region's board, so the season is owed again. Its
    // rows are overwritten in place: every run in the world top 2,000 is also
    // in its own region's top 2,000.
    const regions = (await marker('season-mn-1'))!.regions;
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateOne({ slug: 'season-mn-1' }, { $unset: { 'archive.regions': '' } });

    await archive.archiveBacklog();

    expect(runsRequestsFor('season-mn-1', 'us')).toBeGreaterThan(0);
    expect(runsRequestsFor('season-mn-1', 'eu')).toBeGreaterThan(0);
    const reread = await marker('season-mn-1');
    expect(reread?.status).toBe('complete');
    expect(Object.keys(reread!.regions).sort()).toEqual(Object.keys(regions).sort());
  });

  it('keeps archived rows out of reach of the live pass', async () => {
    // The live collections are rewritten, pruned and eventually retired every
    // season. The archive's own collections are what keeps history out of that.
    const archivedBefore = await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments();
    expect(archivedBefore).toBeGreaterThan(0);

    await app.app.get(MplusService).sweep();

    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments()).toBeGreaterThan(0);
    expect(await db.collection(MPLUS_ARCHIVE_RUNS_COLLECTION).countDocuments()).toBe(
      archivedBefore,
    );
  });

  it('reports its last tick on liveness, without reading the database', async () => {
    const response = await getJson<{
      jobs: { mplusArchive: { lastTickAt: string | null; lastTick: { pending: number } | null } };
    }>(app.url(), '/health');

    expect(response.body.jobs.mplusArchive.lastTickAt).not.toBeNull();
    expect(response.body.jobs.mplusArchive.lastTick?.pending).toBe(0);
  });

  it('holds every invariant', async () => {
    await expectInvariants(db);
  });
});
