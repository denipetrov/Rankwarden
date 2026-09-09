import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import {
  SPEC_REPRESENTATION_COLLECTION,
  startOfUtcDay,
} from '../src/representation/entities/spec-representation.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { SpecRepresentationService } from '../src/representation/spec-representation.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectRepresentationCoherent } from './support/invariants.js';
import { SPECS, World } from './support/world.js';

/**
 * S7 — boundaries: the shapes and edges the ordinary path never reaches.
 *
 * Half of these are about the daily snapshot, which is the one place in the
 * service where an off-by-one is invisible: a wrong `classified` still renders
 * a chart, and a snapshot filed under the wrong UTC day is only noticed weeks
 * later when someone compares two of them.
 */
describe('S7 — edge conditions', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    REPRESENTATION_MIN_RATINGS: '0,1800',
    PROFILE_BATCH_SIZE: '500',
    PROFILE_REQUESTS_PER_SECOND: '2000',
  };

  let harness: TestApp;
  let db: Db;
  let world: World;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const snapshots = () => db.collection(SPEC_REPRESENTATION_COLLECTION);
  const representation = () => harness.app.get(SpecRepresentationService);

  const sweep = async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();
  };

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 60, seed: 7, multiBracketShare: 0.5 });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    await harness.settle();
    await sweep();
    await harness.app.get(ProfileEnrichmentService).run();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S7.10 — a character on nine ladders at once fans out correctly', async () => {
    const player = [...world.players.values()].find((entry) => entry.region === 'us')!;
    const specs = SPECS.slice(0, 3);
    const ladders = [
      '2v2',
      '3v3',
      'rbg',
      ...specs.map((spec) => `shuffle-${spec.classSlug}-${spec.specSlug}`),
      ...specs.map((spec) => `blitz-${spec.classSlug}-${spec.specSlug}`),
    ];

    for (const [index, bracket] of ladders.entries()) {
      world.setRating(player.id, bracket, 1900 + index * 10);
    }
    await sweep();

    const stored = await characters().findOne({ region: 'us', characterId: player.id });
    expect(Object.keys(stored!.brackets).sort()).toEqual([...ladders].sort());
    expect(Object.keys(stored!.ratings).sort(), 'the mirror matches key for key').toEqual(
      [...ladders].sort(),
    );

    // One document, but nine rows spread across five family collections — the
    // shape a per-bracket document model would have got wrong.
    const counts: Record<string, number> = {};
    for (const [family, collection] of Object.entries(RATING_COLLECTIONS)) {
      counts[family] = await db
        .collection(collection)
        .countDocuments({ region: 'us', characterId: player.id });
    }

    expect(counts).toMatchObject({ '2v2': 1, '3v3': 1, rbg: 1, shuffle: 3, blitz: 3 });
  });

  it('S7.13 — an unenriched character counts toward total but not classified', async () => {
    // Everyone above the cutoff is in `total`; only those with a resolved class
    // and spec are in `classified`. A front end gating on that ratio has to be
    // able to trust it.
    const above = await characters().countDocuments({
      region: 'us',
      'ratings.3v3': { $gte: 1800 },
    });
    expect(above, 'somebody is above the cutoff').toBeGreaterThan(2);

    const keep = Math.max(1, Math.floor(above / 2));
    const stripped = await characters()
      .find({ region: 'us', 'ratings.3v3': { $gte: 1800 } })
      .skip(keep)
      .toArray();
    await characters().updateMany(
      { _id: { $in: stripped.map((row) => row._id) } },
      { $unset: { profile: '' } },
    );

    await snapshots().deleteMany({});
    await representation().snapshot();

    const row = await snapshots().findOne({ region: 'us', family: '3v3', minRating: 1800 });
    expect(row!.total, 'everyone above the cutoff').toBe(above);
    expect(row!.classified, 'only the enriched ones').toBe(above - stripped.length);
    expect(row!.classified).toBeLessThan(row!.total);

    // Shares are computed over `classified`, not over `total`.
    const shares = (row!.specs as { share: number }[]).reduce((sum, entry) => sum + entry.share, 0);
    expect(shares).toBeCloseTo(1, 2);
    await expectRepresentationCoherent(db);
  });

  it('S7.14 — a stray aggregate key inflates neither total nor classified', async () => {
    // A document the boot purge missed. `total` is only incremented once the
    // bracket key parses, so an unparseable key contributes to neither figure —
    // and this was the only way invariant I9 could ever fail.
    const victim = await characters().findOne({ region: 'us', 'ratings.3v3': { $gte: 1800 } });
    const before = await snapshots().findOne({ region: 'us', family: '3v3', minRating: 1800 });

    await characters().updateOne(
      { _id: victim!._id },
      { $set: { 'ratings.shuffle-overall': 2400 } },
    );

    try {
      await snapshots().deleteMany({});
      await representation().snapshot();

      const after = await snapshots().findOne({ region: 'us', family: '3v3', minRating: 1800 });
      expect(after!.total).toBe(before!.total);
      expect(after!.classified).toBe(before!.classified);

      const shuffle = await snapshots().findOne({ region: 'us', family: 'shuffle', minRating: 0 });
      expect(
        (shuffle?.specs as { spec: string }[] | undefined)?.some(
          (entry) => entry.spec === 'overall',
        ),
        'the aggregate never becomes a spec in its own right',
      ).toBeFalsy();

      await expectRepresentationCoherent(db);
    } finally {
      await characters().updateOne(
        { _id: victim!._id },
        { $unset: { 'ratings.shuffle-overall': '' } },
      );
    }
  });

  it('S7.15 — a cutoff of zero does not sweep in characters lacking the key', async () => {
    // The schema permits 0, and `{ $gte: 0 }` is the one comparison where a
    // missing field could plausibly match. It does not: a missing field indexes
    // as null, and type bracketing keeps null out of a numeric range.
    const holders = await characters().countDocuments({
      region: 'us',
      'ratings.rbg': { $exists: true },
    });
    const everyone = await characters().countDocuments({ region: 'us' });
    expect(holders, 'some characters have no rbg rating at all').toBeLessThan(everyone);

    const matched = await characters().countDocuments({ region: 'us', 'ratings.rbg': { $gte: 0 } });
    expect(matched, 'zero is a rating, not a wildcard').toBe(holders);

    await snapshots().deleteMany({});
    await representation().snapshot();
    const row = await snapshots().findOne({ region: 'us', family: 'rbg', minRating: 0 });
    expect(row?.total ?? 0).toBe(holders);
  });

  describe('S7.11 — the UTC day boundary', () => {
    const lastMoment = new Date('2026-05-14T23:59:59.999Z');
    const firstMoment = new Date('2026-05-15T00:00:00.000Z');

    beforeAll(async () => {
      await snapshots().deleteMany({});
      await representation().snapshot(lastMoment);
      await representation().snapshot(firstMoment);
    });

    it('files a millisecond either side under different days', async () => {
      const dates = (await snapshots().distinct('date')).map((date) =>
        (date as Date).toISOString(),
      );

      expect(dates).toContain(startOfUtcDay(lastMoment).toISOString());
      expect(dates).toContain(startOfUtcDay(firstMoment).toISOString());
      expect(startOfUtcDay(lastMoment).getTime()).not.toBe(startOfUtcDay(firstMoment).getTime());
    });

    it('re-running inside the same day upserts rather than duplicating', async () => {
      const before = await snapshots().countDocuments();
      await representation().snapshot(new Date('2026-05-15T12:00:00.000Z'));

      expect(await snapshots().countDocuments(), 'same day, same rows').toBe(before);
    });

    it('answers isSnapshotDue correctly on both sides of midnight', async () => {
      expect(await representation().isSnapshotDue(firstMoment), 'already written').toBe(false);
      expect(
        await representation().isSnapshotDue(new Date('2026-05-16T00:00:00.000Z')),
        'the next day is owed one',
      ).toBe(true);
    });
  });

  it('S7.18 — a late enrichment write cannot resurrect a deleted character', async () => {
    const victim = await characters().findOne({ region: 'us' });
    const player = world.player(victim!.characterId);
    const before = await characters().countDocuments();

    await characters().updateOne(
      { _id: victim!._id },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
    );

    // The document is removed between the fetch and the write, from inside the
    // fake, so the race is at a known point rather than whenever a timer lands.
    const original = harness.blizzard.get.bind(harness.blizzard);
    const target = `${player.realmSlug}/${encodeURIComponent(player.name.toLowerCase())}`;
    let removed = false;

    harness.blizzard.get = async (region, path, options) => {
      const payload = await original(region, path, options);
      if (!removed && path.includes(target)) {
        removed = true;
        await characters().deleteOne({ _id: victim!._id });
      }

      return payload;
    };

    try {
      await harness.app.get(ProfileEnrichmentService).run();
    } finally {
      harness.blizzard.get = original;
    }

    expect(removed, 'the character really was deleted mid-flight').toBe(true);

    // `saveProfileSummary` is an `updateOne` with no upsert, so it matches zero
    // documents, throws nothing, and creates nothing. A future `upsert: true`
    // would silently bring back a character that has left the ladder.
    expect(
      await characters().countDocuments({ region: 'us', characterId: victim!.characterId }),
      'no document was recreated by the write that arrived too late',
    ).toBe(0);
    expect(await characters().countDocuments()).toBe(before - 1);
  });
});
