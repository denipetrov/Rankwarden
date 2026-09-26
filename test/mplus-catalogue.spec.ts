import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MPLUS_AFFIXES_COLLECTION } from '../src/mplus/entities/mplus-affix.entity.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import {
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { MplusSeasonService } from '../src/mplus-season/mplus-season.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const DAY = 86_400_000;

/**
 * M1.1, M1.6-M1.9 — the catalogue walk and the indexes that exist
 * before anything is read (C4, C6, C7, and F6).
 *
 * Three expansions are listed — The War Within (10), Midnight (11) and the one
 * after (12) — so a failure in the middle one has something after it to lose.
 */
describe('Mythic+ catalogue walk and indexes', () => {
  let app: TestApp;
  let db: Db;
  let catalogue: MplusCatalogueService;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const staticRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/static-data');
  const stamps = async () =>
    new Map(
      (await db.collection(MPLUS_SEASONS_COLLECTION).find({}).toArray()).map((season) => [
        season.slug as string,
        (season.catalogueUpdatedAt as Date).getTime(),
      ]),
    );
  const ageEverything = (ms: number) =>
    db
      .collection(MPLUS_SEASONS_COLLECTION)
      .updateMany({}, { $set: { catalogueUpdatedAt: new Date(Date.now() - ms) } });

  beforeAll(async () => {
    world.seasons.push(
      {
        slug: 'season-tww-3',
        name: 'TWW Season 3',
        blizzardSeasonId: 15,
        isMainSeason: true,
        expansionId: 10,
        starts: { us: '2025-08-12T15:00:00Z' },
        ends: { us: '2026-03-02T22:00:00Z' },
        dungeons: 8,
      },
      {
        slug: 'season-next-1',
        name: 'Next Season 1',
        blizzardSeasonId: 21,
        isMainSeason: true,
        expansionId: 12,
        starts: { us: '2027-09-01T15:00:00Z' },
        ends: { us: '2030-01-01T00:00:00Z' },
        dungeons: 8,
        firstDungeonId: 12_000,
      },
    );

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_CATALOGUE_FIRST_EXPANSION: '10' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    catalogue = app.app.get(MplusCatalogueService);
    await app.listen();
  });

  afterEach(() => {
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M1.1 every Mythic+ index exists on an empty database, with its keys', async () => {
    const indexes = async (collection: string) =>
      Object.fromEntries(
        (await db.collection(collection).indexes())
          .filter((index) => index.name !== '_id_')
          .map((index) => [index.name, { key: index.key, unique: index.unique === true }]),
      );
    const plain = (key: Record<string, number>) => ({ key, unique: false });
    const unique = (key: Record<string, number>) => ({ key, unique: true });

    expect(await indexes(MPLUS_RUNS_COLLECTION)).toEqual({
      run_identity: unique({ season: 1, region: 1, keystoneRunId: 1 }),
      run_board: plain({ season: 1, region: 1, score: -1 }),
      run_dungeon_board: plain({ season: 1, region: 1, 'dungeon.id': 1, score: -1 }),
      run_roster: plain({ season: 1, region: 1, rosterKeys: 1 }),
      run_freshness: plain({ season: 1, region: 1, fetchedAt: 1 }),
    });
    // No freshness index on characters: nothing selects them by age (§5.5).
    expect(await indexes(MPLUS_CHARACTERS_COLLECTION)).toEqual({
      mplus_character_identity: unique({ season: 1, key: 1 }),
      mplus_score_board: plain({ season: 1, region: 1, mythicScore: -1 }),
      mplus_character_lookup: plain({ nameKey: 1, realmSlug: 1 }),
    });
    expect(await indexes(MPLUS_AFFIXES_COLLECTION)).toEqual({
      affix_identity: unique({ id: 1 }),
    });
    expect(await indexes(MPLUS_SEASONS_COLLECTION)).toEqual({
      season_identity: unique({ slug: 1 }),
      season_expansion: plain({ expansionId: 1 }),
    });
    expect(await indexes(MPLUS_DUNGEONS_COLLECTION)).toEqual({
      dungeon_identity: unique({ id: 1 }),
    });
    expect(await indexes(MPLUS_ARCHIVE_RUNS_COLLECTION)).toEqual({
      archive_run_identity: unique({ season: 1, keystoneRunId: 1 }),
      archive_run_board: plain({ season: 1, score: -1 }),
      archive_run_region_board: plain({ season: 1, region: 1, score: -1 }),
      archive_run_dungeon_board: plain({ season: 1, 'dungeon.id': 1, score: -1 }),
      archive_run_roster: plain({ season: 1, rosterKeys: 1 }),
    });
    expect(await indexes(MPLUS_ARCHIVE_CHARACTERS_COLLECTION)).toEqual({
      archive_character_identity: unique({ season: 1, key: 1 }),
      archive_score_board: plain({ season: 1, mythicScore: -1 }),
      archive_score_region_board: plain({ season: 1, region: 1, mythicScore: -1 }),
      archive_character_lookup: plain({ nameKey: 1, realmSlug: 1 }),
    });
    // And no legacy one-per-region identity, which would refuse every
    // per-dungeon document.
    expect(await indexes(MPLUS_SPEC_REPRESENTATION_COLLECTION)).toEqual({
      mplus_representation_key: unique({ season: 1, region: 1, dungeonId: 1 }),
      mplus_representation_by_region: plain({ region: 1, season: 1 }),
    });
    expect(await indexes(MPLUS_SEASON_STATE_COLLECTION)).toEqual({
      mplus_state_region: unique({ region: 1 }),
    });
    expect(await indexes(MPLUS_SEASON_TRANSITIONS_COLLECTION)).toEqual({
      mplus_transition_identity: unique({ season: 1, region: 1 }),
      mplus_transition_recent: plain({ purgedAt: -1 }),
    });
  });

  it('M1.6 a failed expansion stops the walk and keeps what was written', async () => {
    app.raiderIo.failWith('expansion:11', { status: 500 });

    const result = await catalogue.refresh();

    expect(result.refreshed).toBe(true);
    expect(result.expansions).toEqual([10]);
    expect(staticRequests().map((request) => request.expansionId)).toEqual([10, 11]);
    expect(
      (await db.collection(MPLUS_SEASONS_COLLECTION).distinct('slug')).sort(),
      'only what the walk reached',
    ).toEqual(['season-tww-3']);

    const warnings = logger.of('warn', /expansion 11/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/stopping the walk here/);

    // The next refresh starts from the beginning, not from where this one fell.
    app.raiderIo.reset();
    const next = await catalogue.refresh();
    expect(next.expansions).toEqual([10, 11, 12]);
    expect(staticRequests().map((request) => request.expansionId)).toEqual([10, 11, 12, 13]);
  });

  it('M1.7 freshness is judged by the oldest stamp, so a partial walk is retried at once', async () => {
    // Everything read two days ago, then a walk that failed after expansion 10
    // re-stamped only 10: the newest stamp is fresh, the oldest is not.
    await ageEverything(2 * DAY);
    app.raiderIo.failWith('expansion:11', { status: 500, times: 1 });
    await catalogue.refresh();
    const partial = await stamps();
    expect(partial.get('season-tww-3')!).toBeGreaterThan(Date.now() - 60_000);
    expect(partial.get('season-mn-2')!).toBeLessThan(Date.now() - DAY);

    app.raiderIo.reset();
    const retried = await catalogue.refreshIfDue();
    expect(retried.refreshed, 'not "catalogue is fresh"').toBe(true);
    expect(retried.expansions).toEqual([10, 11, 12]);

    app.raiderIo.reset();
    const settled = await catalogue.refreshIfDue();
    expect(settled.refreshed).toBe(false);
    expect(staticRequests(), 'a whole walk later, the TTL holds').toHaveLength(0);
  });

  it('M1.9 the admin route and the season check asking at once walk once', async () => {
    await ageEverything(2 * DAY);
    app.raiderIo.delayMs = 30;

    const [route, ensured] = await Promise.all([
      postJson<{ expansions: number[] }>(app.url(), '/admin/mplus-catalogue'),
      app.app.get(MplusSeasonService).ensureCatalogue(),
    ]);

    expect(route.status).toBe(201);
    expect(route.body.expansions).toEqual([10, 11, 12]);
    expect(ensured.expansions).toEqual([10, 11, 12]);
    // One walk: each expansion once, and the empty one that ends it.
    expect(staticRequests().map((request) => request.expansionId)).toEqual([10, 11, 12, 13]);
  });

  /** Walks made by three `refreshIfDue` calls over a fresh catalogue plus one stale leftover. */
  const walksWithALeftover = async () => {
    app.raiderIo.delayMs = 0;
    await catalogue.refresh();
    // A season Raider.io no longer lists — renamed, dropped, or below a raised
    // MPLUS_CATALOGUE_FIRST_EXPANSION. No walk will ever stamp it again.
    await db.collection(MPLUS_SEASONS_COLLECTION).updateOne(
      { slug: 'season-gone' },
      {
        $set: {
          slug: 'season-gone',
          name: 'Gone',
          expansionId: 9,
          dungeonIds: [],
          starts: {},
          ends: {},
          catalogueUpdatedAt: new Date(Date.now() - 3 * DAY),
        },
      },
      { upsert: true },
    );
    app.raiderIo.reset();

    for (let call = 0; call < 3; call += 1) await catalogue.refreshIfDue();

    return staticRequests().filter((request) => request.expansionId === 10).length;
  };

  it('M1.8 [F6] today: one season no walk re-stamps keeps the catalogue due for ever', async () => {
    expect(await walksWithALeftover(), 'a full walk on every call').toBe(3);
    await db.collection(MPLUS_SEASONS_COLLECTION).deleteOne({ slug: 'season-gone' });
  });

  // Confirmed 2026-09-25 ("expected 3 to be less than or equal to 1"). Remove `.fails`
  // with the fix.
  it.fails('M1.8 [F6] desired: a leftover season does not keep the catalogue due', async () => {
    const walks = await walksWithALeftover();
    await db.collection(MPLUS_SEASONS_COLLECTION).deleteOne({ slug: 'season-gone' });

    expect(walks).toBeLessThanOrEqual(1);
  });
});
