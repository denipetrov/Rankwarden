import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import {
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from '../src/mplus-season/mplus-season-events.service.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { MplusSeasonService } from '../src/mplus-season/mplus-season.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { expectInvariants, expectNoOrphanMplusCharacters } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld, type MplusWorldSeason } from './support/mplus-world.js';
import { World } from './support/world.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * M1.10-M1.12 — how a region's season is chosen, with the season check off so
 * the pass is the only thing that ever looks (L1, L3).
 *
 * Two regions, the US and Korea, because the case that matters is a region no
 * season has opened in yet: it must be skipped, not failed, and not made to
 * degrade readiness for a season that simply has not started there.
 */
describe('Mythic+ season resolution', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();
  const events: MplusSeasonTransitionEvent[] = [];
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const current: MplusWorldSeason = {
    slug: 'season-mn-2',
    name: 'MN Season 2',
    blizzardSeasonId: 18,
    isMainSeason: true,
    starts: { us: at(-7 * DAY), kr: at(DAY) },
    ends: { us: '2030-01-01T00:00:00Z', kr: '2030-01-01T00:00:00Z' },
    dungeons: 8,
  };

  const pass = async () => {
    const result = await app.app.get(MplusService).sweep();
    expect(result).not.toBeNull();

    return result!;
  };

  beforeAll(async () => {
    world.seasons = [current];
    world.seed('us', 30, 500).seed('kr', 20, 480);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us,kr',
        MPLUS_SEASON_REFRESH_ENABLED: 'false',
        MPLUS_PURGE_DRY_RUN: 'false',
        MPLUS_PURGE_REQUIRE_ARCHIVE: 'false',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    app.app.get(MplusSeasonEvents).transitions$.subscribe((event) => events.push(event));
    await app.listen();
  });

  afterEach(() => {
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M1.12 the pass reads an empty catalogue itself, before any runs, with the check off', async () => {
    expect(await db.collection(MPLUS_SEASONS_COLLECTION).countDocuments()).toBe(0);

    await pass();

    const paths = app.raiderIo.requests.map((request) => request.path);
    expect(paths[0]).toBe('mythic-plus/static-data');
    expect(paths.lastIndexOf('mythic-plus/static-data')).toBeLessThan(
      paths.indexOf('mythic-plus/runs'),
    );
    // Recorded by the pass's own observation: nothing else looks.
    const state = await db.collection(MPLUS_SEASON_STATE_COLLECTION).find({}).toArray();
    expect(state.map((entry) => [entry.region, entry.season])).toEqual([['us', 'season-mn-2']]);
  });

  it('M1.10 a region no season has opened in is skipped, not failed', async () => {
    const result = await pass();

    expect(result.regions.map((region) => region.region)).toEqual(['us']);
    expect(result.seasons).toEqual({ us: 'season-mn-2' });
    expect(result.stoppedEarly).toBeNull();
    expect(
      app.raiderIo.requests.filter((request) => request.region === 'kr'),
      'nothing is asked about Korea, not even its cutoffs',
    ).toEqual([]);
    expect(
      logger.matching(/No catalogued Mythic\+ season has opened in kr; skipping 1 region/),
    ).toHaveLength(1);

    const ready = await getJson<{ status: string; mplus: { problems: string[] } }>(
      app.url(),
      '/health/ready',
    );
    expect(ready.body.mplus.problems).toEqual([]);
    expect(ready.body.status).toBe('ok');

    const live = await getJson<{ mplusSeasons: Record<string, unknown> }>(app.url(), '/health');
    expect(Object.keys(live.body.mplusSeasons)).toEqual(['us']);
  });

  it('M1.12 a catalogue change is noticed by the next pass even though nothing else checks', async () => {
    // Korea opens the season, and the catalogue is past its TTL.
    current.starts.kr = at(-HOUR);
    await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateMany({}, { $set: { catalogueUpdatedAt: new Date(Date.now() - 2 * DAY) } });

    const result = await pass();

    expect(app.raiderIo.countMatching('mythic-plus/static-data')).toBeGreaterThan(0);
    expect(result.seasons).toEqual({ us: 'season-mn-2', kr: 'season-mn-2' });
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'kr' })).toBe(20);
  });

  it('M1.11 a current season whose start moves into the future retires nothing', async () => {
    // An older season, with rows of its own in the US.
    world.seasons.push({
      slug: 'season-mn-1',
      name: 'MN Season 1',
      blizzardSeasonId: 17,
      isMainSeason: true,
      starts: { us: at(-200 * DAY), kr: at(-200 * DAY) },
      ends: { us: at(-8 * DAY), kr: at(-8 * DAY) },
      dungeons: 8,
    });
    for (const collection of [MPLUS_RUNS_COLLECTION, MPLUS_CHARACTERS_COLLECTION]) {
      const rows = await db
        .collection(collection)
        .find({ season: 'season-mn-2', region: 'us' }, { projection: { _id: 0 } })
        .toArray();
      await db
        .collection(collection)
        .insertMany(rows.map((row) => ({ ...row, season: 'season-mn-1' })));
    }
    await app.app.get(MplusCatalogueService).refresh();
    events.length = 0;

    // Raider.io corrects mn-2's US start to tomorrow.
    current.starts.us = at(DAY);
    await app.app.get(MplusCatalogueService).refresh();
    await app.app.get(MplusSeasonService).observe();

    // Followed — the US resolves back to mn-1 — but as a correction, not a
    // rollover: nothing is announced, so nothing reacts as if a season began.
    expect(events).toEqual([]);
    expect(
      logger.of('warn', /Mythic\+ season correction in us: season-mn-2 .* back to season-mn-1/),
    ).toHaveLength(1);

    const counts = async () => ({
      mn1: await db
        .collection(MPLUS_RUNS_COLLECTION)
        .countDocuments({ season: 'season-mn-1', region: 'us' }),
      mn2: await db
        .collection(MPLUS_RUNS_COLLECTION)
        .countDocuments({ season: 'season-mn-2', region: 'us' }),
    });
    const before = await counts();

    const result = await pass();
    expect(result.seasons.us).toBe('season-mn-1');

    // mn-2 opened after the season now current, so it is not superseded by it.
    const { plan, purged } = await app.app.get(MplusSeasonTransitionService).run();
    expect(plan.current).toEqual({ us: 'season-mn-1', kr: 'season-mn-2' });
    expect(plan.candidates).toEqual([]);
    expect(purged).toEqual([]);
    expect(await counts()).toEqual(before);

    await expectNoOrphanMplusCharacters(db);
    await expectInvariants(db);
  });

  it("M8.6 each region's cutoffs are read for that region's own season", async () => {
    // The state M1.11 left: the US on mn-1, Korea on mn-2, neither archived.
    const result = await pass();
    expect(result.seasons).toEqual({ us: 'season-mn-1', kr: 'season-mn-2' });

    const cutoffs = app.raiderIo.requests
      .filter((request) => request.path === 'mythic-plus/season-cutoffs')
      .map((request) => `${request.region}:${request.season}`)
      .sort();
    expect(cutoffs).toEqual(['kr:season-mn-2', 'us:season-mn-1']);

    const stored = await db
      .collection(MPLUS_SEASONS_COLLECTION)
      .find({}, { projection: { slug: 1, cutoffs: 1 } })
      .toArray();
    const regionsOf = (slug: string) =>
      Object.keys(stored.find((season) => season.slug === slug)?.cutoffs ?? {}).sort();
    expect(regionsOf('season-mn-1')).toEqual(['us']);
    // mn-2 holds the US's figures from before the correction, and Korea's now.
    expect(regionsOf('season-mn-2')).toEqual(['kr', 'us']);
  });

  it('M5.6 a retired pair whose rows come back is retired again, and recorded once', async () => {
    // Raider.io puts mn-2's US start back: mn-1 is superseded in the US again.
    current.starts.us = at(-7 * DAY);
    await app.app.get(MplusCatalogueService).refresh();
    const transitions = app.app.get(MplusSeasonTransitionService);

    const first = await transitions.run();
    expect(first.purged.map((entry) => [entry.season, entry.region])).toEqual([
      ['season-mn-1', 'us'],
    ]);
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-mn-1' }),
    ).toBe(0);
    const firstRecord = await db
      .collection(MPLUS_SEASON_TRANSITIONS_COLLECTION)
      .findOne({ season: 'season-mn-1', region: 'us' });

    // Rows for the retired season come back — a late pass, a sync.
    const rows = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .find({ season: 'season-mn-2', region: 'us' }, { projection: { _id: 0 } })
      .limit(4)
      .toArray();
    await db
      .collection(MPLUS_RUNS_COLLECTION)
      .insertMany(rows.map((row) => ({ ...row, season: 'season-mn-1' })));

    const second = await transitions.run();
    expect(second.purged).toEqual([
      expect.objectContaining({
        season: 'season-mn-1',
        region: 'us',
        removed: { [MPLUS_CHARACTERS_COLLECTION]: 0, [MPLUS_RUNS_COLLECTION]: 4 },
      }),
    ]);
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-mn-1' }),
    ).toBe(0);

    // One row per pair: the second purge overwrites the first's counts and
    // time. Pinned as it is; if the history matters, the identity has to change.
    const records = await db
      .collection(MPLUS_SEASON_TRANSITIONS_COLLECTION)
      .find({ season: 'season-mn-1', region: 'us' })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0].removed[MPLUS_RUNS_COLLECTION]).toBe(4);
    expect(records[0].purgedAt.getTime()).toBeGreaterThan(firstRecord!.purgedAt.getTime());
    await expectNoOrphanMplusCharacters(db);
  });
});
