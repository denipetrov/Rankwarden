import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';
import { RAIDS_COLLECTION } from '../src/database/collections.js';

const REGIONS = ['world', 'us', 'eu', 'kr', 'tw'];

/**
 * Raid plan R1 — the catalogue as the rankings depend on it: what a raid
 * appearing, closing, vanishing, coming back or being renamed does to the
 * boards hung on it.
 *
 * Mythic only, and every ranking run asked for by hand: no sweep is run, so the
 * scheduler never opens its gates and the only requests are the ones a case
 * makes.
 */
describe('Raid plan R1 — the catalogue under the boards', () => {
  let app: TestApp;
  let db: Db;
  let catalogue: RaidCatalogueService;
  let rankings: RaidRankingsService;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const staticRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/static-data');
  const started = (slug: string) =>
    app.raiderIo.requests
      .filter(
        (request) =>
          request.path === 'raiding/raid-rankings' &&
          request.params.raid === slug &&
          request.page === 0,
      )
      .map((request) => request.region);
  const raid = (filter: Record<string, unknown>) => db.collection(RAIDS_COLLECTION).findOne(filter);

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_DIFFICULTIES: 'mythic',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    catalogue = app.app.get(RaidCatalogueService);
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    await app.listen();
  });

  afterEach(() => {
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('R1.6 a raid listed before it opens is stored, read as open, and empty without complaint', async () => {
    world.raids.push({
      id: 17_000,
      slug: 'the-unopened-vault',
      name: 'The Unopened Vault',
      expansionId: 11,
      starts: { us: '2027-03-01T15:00:00Z', eu: '2027-03-02T04:00:00Z' },
      ends: { us: '2030-01-01T00:00:00Z', eu: '2030-01-01T00:00:00Z' },
      encounters: [{ id: 220_001, slug: 'the-first-door', name: 'The First Door' }],
    });

    await catalogue.refresh();
    const first = await rankings.refreshDue();

    const stored = (await raid({ slug: 'the-unopened-vault' }))!;
    expect(stored.starts.us).toEqual(new Date('2027-03-01T15:00:00Z'));
    expect(stored.guilds).toEqual(
      Object.fromEntries(REGIONS.map((region) => [region, { mythic: [] }])),
    );
    expect(first).toMatchObject({ failed: 0, stopped: null });

    // Open, so read again next run — one request a board, as nobody is on it.
    app.raiderIo.reset();
    await rankings.refreshDue();
    expect(started('the-unopened-vault')).toEqual(REGIONS);
    expect(logger.of('warn', /raid|rank|vault/i)).toEqual([]);
  });

  it('R1.3 a real end date replacing the placeholder settles the raid after one more read', async () => {
    // Last read while it was open, three weeks before what turns out to be its end.
    const whileOpen = new Date('2026-09-01T00:00:00Z');
    await db.collection(RAIDS_COLLECTION).updateOne(
      { slug: 'the-venomous-abyss' },
      {
        $set: Object.fromEntries(
          REGIONS.map((region) => [`guildsUpdatedAt.${region}.mythic`, whileOpen]),
        ),
      },
    );
    const abyss = world.raids.find((entry) => entry.slug === 'the-venomous-abyss')!;
    abyss.ends = { us: '2026-09-22T15:00:00Z', eu: '2026-09-23T04:00:00Z' };

    await catalogue.refresh();
    expect((await raid({ slug: 'the-venomous-abyss' }))!.ends.eu).toEqual(
      new Date('2026-09-23T04:00:00Z'),
    );

    await rankings.refreshDue();
    expect(started('the-venomous-abyss'), 'once more, now that it has closed').toEqual(REGIONS);

    app.raiderIo.reset();
    await rankings.refreshDue();
    expect(started('the-venomous-abyss'), 'and then never by itself').toEqual([]);
  });

  it('R1.2 a raid listed again stops being unlisted, keeps its boards, and is read again', async () => {
    const vault = world.raids.find((entry) => entry.slug === 'the-unopened-vault')!;
    world.raids = world.raids.filter((entry) => entry !== vault);
    await catalogue.refresh();

    const unlisted = (await raid({ slug: 'the-unopened-vault' }))!;
    expect(unlisted.unlistedAt).toBeInstanceOf(Date);
    await rankings.refreshDue();
    expect(started('the-unopened-vault'), 'an unlisted raid is not read').toEqual([]);

    world.raids.push(vault);
    await catalogue.refresh();

    const relisted = (await raid({ slug: 'the-unopened-vault' }))!;
    expect(relisted.unlistedAt).toBeUndefined();
    expect(relisted.guilds, 'the boards it had are still there').toEqual(unlisted.guilds);
    expect(relisted.guildsUpdatedAt).toEqual(unlisted.guildsUpdatedAt);

    app.raiderIo.reset();
    await rankings.refreshDue();
    expect(started('the-unopened-vault')).toEqual(REGIONS);
  });

  it('R1.4 a raid that changes slug is still one document, asked for by its new name', async () => {
    const before = (await raid({ id: 16_178 }))!;
    const manaforge = world.raids.find((entry) => entry.id === 16_178)!;
    manaforge.slug = 'manaforge-omega-remastered';
    for (const guild of world.guilds) {
      if (!guild.progress['manaforge-omega']) continue;
      guild.progress['manaforge-omega-remastered'] = guild.progress['manaforge-omega'];
      delete guild.progress['manaforge-omega'];
    }

    await catalogue.refresh();

    expect(await db.collection(RAIDS_COLLECTION).countDocuments({ id: 16_178 })).toBe(1);
    expect(await raid({ slug: 'manaforge-omega' }), 'the old name is gone').toBeNull();
    const after = (await raid({ id: 16_178 }))!;
    expect(after.slug).toBe('manaforge-omega-remastered');
    expect(after.guilds, 'identity is the id: the boards stay').toEqual(before.guilds);
    expect(after.guilds.world.mythic).toHaveLength(2);

    expect(await rankings.refreshRaid('manaforge-omega')).toBeNull();
    expect(await rankings.refreshRaid('manaforge-omega-remastered')).toMatchObject({ boards: 5 });
    expect(started('manaforge-omega-remastered')).toEqual(REGIONS);
    expect(started('manaforge-omega')).toEqual([]);
  });

  it('R1.5 a 400 in the middle of the list is not taken for the end of it', async () => {
    // Expansion 10 answers 400 this once, while raids of 11 are stored.
    app.raiderIo.failWith('raiding/static-data&expansion:10', { status: 400, times: 1 });
    const stamps = async () =>
      Object.fromEntries(
        (await db.collection(RAIDS_COLLECTION).find({}).toArray()).map((entry) => [
          entry.slug,
          entry.catalogueUpdatedAt as Date,
        ]),
      );
    const before = await stamps();

    const result = await catalogue.refresh();

    expect(staticRequests().map((request) => request.expansionId)).toEqual([10, 11, 12]);
    expect(result).toMatchObject({ expansions: [11], unlisted: 0 });
    expect(
      await db.collection(RAIDS_COLLECTION).countDocuments({ unlistedAt: { $exists: true } }),
      'neither the raids of 10 nor those of 11 are taken for gone',
    ).toBe(0);
    const after = await stamps();
    expect(after['manaforge-omega-remastered'], 'not reached, so not stamped').toEqual(
      before['manaforge-omega-remastered'],
    );
    expect(after['tier-mn-1'].getTime(), 'the expansion after it was still read').toBeGreaterThan(
      before['tier-mn-1'].getTime(),
    );
    expect(
      logger.of('warn', /lists no raids for expansion 10, though raids of expansion 11 are stored/),
    ).toHaveLength(1);
    expect(catalogue.lastStatus.lastWalk).toMatchObject({ complete: false, unlisted: 0 });

    // The boards of expansion 10 are still read: nothing was unlisted.
    await rankings.refreshRaid('manaforge-omega-remastered');
    expect(started('manaforge-omega-remastered')).toEqual(REGIONS);

    // And the next walk, answered properly, is a complete one again.
    await catalogue.refresh();
    expect(catalogue.lastStatus.lastWalk).toMatchObject({ complete: true, expansions: [10, 11] });
  });

  it('R1.1 a walk that ended normally leaves Raider.io healthy, and is reported', async () => {
    await catalogue.refresh();

    const ready = await getJson<{
      dependencies: { raiderio: { status: string; failingRegions: string[] } };
    }>(app.url(), '/health/ready');
    // The 400 for expansion 12 is how the list ends: an answer, not a failure.
    expect(ready.body.dependencies.raiderio).toMatchObject({ status: 'ok', failingRegions: [] });

    const health = await getJson<{ jobs: { raidCatalogue: unknown } }>(app.url(), '/health');
    expect(health.body.jobs.raidCatalogue).toEqual({
      running: false,
      lastWalk: {
        finishedAt: expect.any(String),
        expansions: [10, 11],
        raids: 4,
        unlisted: 0,
        complete: true,
      },
    });
  });

  it('holds every invariant, the boards against the world included', async () => {
    for (const entry of world.raids) await rankings.refreshRaid(entry.slug);

    await expectInvariants(db, undefined, world);
  });
});
