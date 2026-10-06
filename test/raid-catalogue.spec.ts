import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { RaidCatalogueRepository } from '../src/raid/raid-catalogue.repository.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';
import { RAIDS_COLLECTION } from '../src/database/collections.js';

const DAY = 86_400_000;

/**
 * The raid catalogue: every raid Raider.io lists, one document each, with its
 * encounters — kept in step by a walk over expansions that ends on the 400 the
 * endpoint answers for an expansion it does not list.
 *
 * The world lists raids under The War Within (10) and Midnight (11); 12 is
 * unsupported, which is how the walk knows it is done.
 */
describe('Raid catalogue', () => {
  let app: TestApp;
  let db: Db;
  let catalogue: RaidCatalogueService;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const requests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/static-data');
  const stored = () =>
    db
      .collection(RAIDS_COLLECTION)
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray();
  const raid = (slug: string) => db.collection(RAIDS_COLLECTION).findOne({ slug });
  const age = (ms: number, filter: Record<string, unknown> = {}) =>
    db
      .collection(RAIDS_COLLECTION)
      .updateMany(filter, { $set: { catalogueUpdatedAt: new Date(Date.now() - ms) } });

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAID_CATALOGUE_ENABLED: 'true' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    catalogue = app.app.get(RaidCatalogueService);
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

  it('is loaded at boot, by a walk that ends on the unsupported expansion', async () => {
    // 10 and 11 list raids; 12 answers 400, which ends the walk.
    expect(requests().map((request) => request.expansionId)).toEqual([10, 11, 12]);
    expect((await stored()).map((entry) => entry.slug)).toEqual([
      'manaforge-omega',
      'tier-mn-1',
      'the-venomous-abyss',
    ]);
    expect(logger.of('warn', /raid/i), 'the 400 that ends the list is not a failure').toEqual([]);
    expect(
      logger.matching(/Raid catalogue refreshed across expansion\(s\) 10, 11: 3 raid write/),
    ).toHaveLength(1);
  });

  it('reads no ranking while the rankings are switched off', async () => {
    expect(app.raiderIo.countMatching('raiding/raid-rankings')).toBe(0);
    expect(
      await db.collection(RAIDS_COLLECTION).countDocuments({ guilds: { $exists: true } }),
    ).toBe(0);
    expect(await db.collection('guilds').countDocuments()).toBe(0);
  });

  it('stores one document per raid, with its encounters and per-region dates', async () => {
    const manaforge = await raid('manaforge-omega');

    expect(manaforge).toMatchObject({
      id: 16178,
      slug: 'manaforge-omega',
      name: 'Manaforge Omega',
      shortName: 'MFO',
      icon: 'inv_112_achievement_raid_manaforgeomega',
      expansionId: 10,
      starts: { us: new Date('2025-08-12T15:00:00Z'), eu: new Date('2025-08-13T04:00:00Z') },
      ends: { us: new Date('2026-03-02T22:00:00Z'), eu: new Date('2026-03-02T22:00:00Z') },
      encounters: [
        { id: 197124, slug: 'plexus-sentinel', name: 'Plexus Sentinel' },
        { id: 197131, slug: 'dimensius', name: 'Dimensius' },
      ],
    });
    expect(manaforge!.catalogueUpdatedAt).toBeInstanceOf(Date);
    expect(manaforge!.unlistedAt).toBeUndefined();

    // A raid still open carries the placeholder end, stored as it is served.
    expect((await raid('the-venomous-abyss'))!.ends.us).toEqual(new Date('2030-01-01T00:00:00Z'));
  });

  it('is unique by raid id, with the indexes it is read by', async () => {
    const indexes = Object.fromEntries(
      (await db.collection(RAIDS_COLLECTION).indexes())
        .filter((index) => index.name !== '_id_')
        .map((index) => [index.name, { key: index.key, unique: index.unique === true }]),
    );

    expect(indexes).toEqual({
      raid_identity: { key: { id: 1 }, unique: true },
      raid_slug: { key: { slug: 1 }, unique: false },
      raid_expansion: { key: { expansionId: 1 }, unique: false },
    });
    const first = (await stored())[0];
    await expect(db.collection(RAIDS_COLLECTION).insertOne({ ...first })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('makes no request while it is fresh, and one walk once it is past its TTL', async () => {
    const fresh = await catalogue.refreshIfDue();
    expect(fresh.refreshed).toBe(false);
    expect(requests()).toEqual([]);

    await age(2 * DAY);
    const due = await catalogue.refreshIfDue();
    expect(due).toMatchObject({ refreshed: true, expansions: [10, 11] });
    expect(requests()).toHaveLength(3);
    expect(
      await db.collection(RAIDS_COLLECTION).countDocuments(),
      'rewritten, not duplicated',
    ).toBe(3);
  });

  it('keeps a re-release as a raid of its own, and a raid with no icon as null', async () => {
    world.raids.push({
      // Upstream numbers a re-release as the original plus 100,000,000.
      id: 100_016_178,
      slug: 'awakened-manaforge-omega',
      name: 'Awakened Manaforge Omega',
      expansionId: 10,
      starts: { us: '2026-04-01T15:00:00Z' },
      ends: { us: '2026-08-01T15:00:00Z' },
      encounters: [{ id: 197124, slug: 'plexus-sentinel', name: 'Plexus Sentinel' }],
    });

    await catalogue.refresh();

    expect(await db.collection(RAIDS_COLLECTION).countDocuments()).toBe(4);
    const awakened = await raid('awakened-manaforge-omega');
    expect(awakened).toMatchObject({ id: 100_016_178, expansionId: 10, icon: null });
    expect((await raid('manaforge-omega'))!.id, 'the original is untouched').toBe(16178);
  });

  it('updates a raid in place when Raider.io corrects it', async () => {
    const abyss = world.raids.find((entry) => entry.slug === 'the-venomous-abyss')!;
    // The placeholder end is replaced by the real one, and a boss is added.
    abyss.ends = { us: '2027-02-01T15:00:00Z', eu: '2027-02-02T04:00:00Z' };
    abyss.encounters.push({ id: 210009, slug: 'late-addition', name: 'Late Addition' });

    await catalogue.refresh();

    const after = (await raid('the-venomous-abyss'))!;
    expect(after.ends.us).toEqual(new Date('2027-02-01T15:00:00Z'));
    expect(after.encounters.map((encounter: { slug: string }) => encounter.slug)).toEqual([
      'gatekeeper',
      'the-abyssal-queen',
      'late-addition',
    ]);
    expect(await db.collection(RAIDS_COLLECTION).countDocuments({ id: 16915 })).toBe(1);
  });

  it('does not erase a field another job stored on the raid', async () => {
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne({ id: 16178 }, { $set: { progress: { marker: 'kept' } } });

    await catalogue.refresh();

    expect((await raid('manaforge-omega'))!.progress).toEqual({ marker: 'kept' });
    await db.collection(RAIDS_COLLECTION).updateOne({ id: 16178 }, { $unset: { progress: '' } });
  });

  it('marks a raid Raider.io stops listing as unlisted, keeps it, and stays fresh', async () => {
    world.raids = world.raids.filter((entry) => entry.slug !== 'awakened-manaforge-omega');

    const result = await catalogue.refresh();

    expect(result.unlisted).toBe(1);
    const gone = (await raid('awakened-manaforge-omega'))!;
    expect(gone, 'kept, not deleted').not.toBeNull();
    expect(gone.unlistedAt).toBeInstanceOf(Date);

    // Never stamped again, so it must not keep the catalogue due for ever.
    await age(3 * DAY, { slug: 'awakened-manaforge-omega' });
    app.raiderIo.reset();
    for (let call = 0; call < 3; call += 1) await catalogue.refreshIfDue();
    expect(requests(), 'the TTL holds').toEqual([]);

    // Listed again, it is a listed raid again.
    world.raids.push({
      id: 100_016_178,
      slug: 'awakened-manaforge-omega',
      name: 'Awakened Manaforge Omega',
      expansionId: 10,
      starts: { us: '2026-04-01T15:00:00Z' },
      ends: { us: '2026-08-01T15:00:00Z' },
      encounters: [],
    });
    await catalogue.refresh();
    expect((await raid('awakened-manaforge-omega'))!.unlistedAt).toBeUndefined();
  });

  it('stops at an expansion that fails, without taking the later ones for gone', async () => {
    app.raiderIo.failWith('raiding/static-data&expansion:11', { status: 503 });
    const before = (await raid('tier-mn-1'))!.catalogueUpdatedAt as Date;

    const result = await catalogue.refresh();

    expect(result).toMatchObject({ expansions: [10], unlisted: 0 });
    expect(requests().map((request) => request.expansionId)).toEqual([10, 11]);
    const mn1 = (await raid('tier-mn-1'))!;
    expect(mn1.unlistedAt, 'not reached is not the same as not listed').toBeUndefined();
    expect(mn1.catalogueUpdatedAt).toEqual(before);
    expect(
      logger.of('warn', /raid catalogue for expansion 11.*stopping the walk here/),
    ).toHaveLength(1);

    // The oldest stamp is still fresh, so nothing is due — and once it is not,
    // the walk starts again from the beginning.
    app.raiderIo.reset();
    await age(2 * DAY, { expansionId: 11 });
    expect((await catalogue.refreshIfDue()).expansions).toEqual([10, 11]);
  });

  it('fails one expansion on a payload that does not parse, as a failure rather than an end', async () => {
    app.raiderIo.corrupt('raiding/static-data&expansion:11', { raids: 'nope' }, 1);

    const result = await catalogue.refresh();

    expect(result).toMatchObject({ expansions: [10], unlisted: 0 });
    expect(logger.of('warn', /schema issues: raids:/)).toHaveLength(1);
  });

  it('POST /admin/raid-catalogue re-reads it now, charged to nothing but "other"', async () => {
    const budget = app.app.get(RaiderIoBudget);
    const before = { other: budget.spent('other'), mplus: budget.spent('mplus') };

    const response = await postJson<{ refreshed: boolean; expansions: number[]; raids: number }>(
      app.url(),
      '/admin/raid-catalogue',
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ refreshed: true, expansions: [10, 11] });
    expect(requests(), 'walked even though it was fresh').toHaveLength(3);
    expect(budget.spent('other') - before.other).toBe(3);
    expect(budget.spent('mplus')).toBe(before.mplus);
  });

  it('answers a lookup by slug, which is what the raiding endpoints are asked by', async () => {
    const repository = app.app.get(RaidCatalogueRepository);

    expect((await repository.findBySlug('tier-mn-1'))?.id).toBe(16340);
    expect(await repository.findBySlug('no-such-raid')).toBeNull();
    expect((await repository.allRaids()).map((entry) => entry.expansionId)).toEqual([
      10, 10, 11, 11,
    ]);
    await expectInvariants(db);
  });
});
