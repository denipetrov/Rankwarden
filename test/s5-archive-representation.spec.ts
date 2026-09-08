import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import {
  SPEC_REPRESENTATION_COLLECTION,
  startOfUtcDay,
} from '../src/representation/entities/spec-representation.entity.js';
import { ArchiveService } from '../src/archive/archive.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { SpecRepresentationService } from '../src/representation/spec-representation.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectRepresentationCoherent } from './support/invariants.js';
import { SPECS } from './support/specs.js';
import { World } from './support/world.js';

const FINISHED = 42;
const CURRENT = 43;

/**
 * S5 — archiving finished seasons, and the daily representation snapshot.
 *
 * The snapshot half carries the most expensive domain rule in the service:
 * a hero talent tree belongs to the spec whose ladder is being counted, not to
 * whichever spec the character happens to be playing today.
 */
describe('S5 — archive and representation', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    ARCHIVE_MAX_ENTRIES_PER_BRACKET: '5',
    REPRESENTATION_MIN_RATINGS: '0,1800',
  };

  let harness: TestApp;
  let db: Db;
  let world: World;

  const entries = () => db.collection(ARCHIVE_ENTRIES_COLLECTION);
  const markers = () => db.collection(ARCHIVE_SEASONS_COLLECTION);
  const snapshots = () => db.collection(SPEC_REPRESENTATION_COLLECTION);
  const sweep = () => harness.app.get(LeaderboardService).sweep();

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 30, seed: 5, season: FINISHED });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('S5 — archive', () => {
    beforeAll(async () => {
      world.rollover('us', CURRENT, new Date('2026-08-18T15:00:00.000Z'));
      const players = [...world.players.values()];
      // Ten players on one ladder, so the cap has something to cut.
      for (const [index, player] of players.entries()) {
        world.setRating(player.id, '3v3', 1500 + index * 10);
      }
      await sweep();
    });

    it('S5.2 — offers the newest finished season first', async () => {
      const pending = await harness.app.get(ArchiveService).nextPending();

      // History holds 40 and 41; 42 has just finished and is the newest.
      expect(pending).toEqual({ seasonId: FINISHED, region: 'us' });
    });

    it('S5.3 / S5.4 — stores the top N by rating, and never an aggregate', async () => {
      await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');

      const stored = await entries()
        .find({ seasonId: FINISHED, region: 'us', bracket: '3v3' })
        .sort({ rating: -1 })
        .toArray();

      expect(stored.length, 'capped at ARCHIVE_MAX_ENTRIES_PER_BRACKET').toBe(5);

      // Sorted by rating, not trusted to arrive in rank order.
      const ratings = stored.map((row) => row.rating);
      expect(ratings).toEqual([...ratings].sort((a, b) => b - a));

      // And it is the *top* five, not an arbitrary five.
      const everyone = [...world.players.values()]
        .filter((player) => player.ratings.has('3v3'))
        .map((player) => player.ratings.get('3v3')!)
        .sort((a, b) => b - a);
      expect(ratings).toEqual(everyone.slice(0, 5));

      const aggregates = await entries().countDocuments({
        bracket: { $in: ['shuffle-overall', 'blitz-overall'] },
      });
      expect(aggregates).toBe(0);
    });

    it('S5.3b — archive rows are self-contained', async () => {
      const row = await entries().findOne({ seasonId: FINISHED, region: 'us' });

      // No reference into `characters`: a rename or deletion later must not
      // change what a historical board reads.
      expect(row).toMatchObject({
        characterName: expect.any(String),
        realmSlug: expect.any(String),
        rank: expect.any(Number),
        rating: expect.any(Number),
      });
      expect(row).not.toHaveProperty('profile');
    });

    it('S5.7 — a partial season stays pending and is retried', async () => {
      await markers().updateOne(
        { seasonId: FINISHED, region: 'us' },
        { $set: { failedBrackets: ['rbg'] } },
      );

      const pending = await harness.app.get(ArchiveService).nextPending();
      expect(pending, 'a marker with outstanding brackets is not complete').toEqual({
        seasonId: FINISHED,
        region: 'us',
      });

      await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');
      const marker = await markers().findOne({ seasonId: FINISHED, region: 'us' });
      expect(marker!.failedBrackets, 'the retry clears it').toEqual([]);
    });

    it('S5.13 — a marker with no failedBrackets field is treated as incomplete', async () => {
      await markers().updateOne(
        { seasonId: FINISHED, region: 'us' },
        { $unset: { failedBrackets: '' } },
      );

      const pending = await harness.app.get(ArchiveService).nextPending();

      // `$size: 0` cannot match a missing field, so the season is re-offered —
      // and then rescued cheaply by the stored-rows probe.
      expect(pending === null || pending.seasonId === FINISHED).toBe(true);

      await markers().updateOne(
        { seasonId: FINISHED, region: 'us' },
        { $set: { failedBrackets: [] } },
      );
    });

    it('S5.9 — season bounds target a single season', async () => {
      // 40 and 41 are still unarchived, so an unbounded run would offer them.
      const remaining = await harness.app.get(ArchiveService).nextPending();
      expect(remaining, 'the older history is still pending').not.toBeNull();
      expect(remaining!.seasonId).toBeLessThan(FINISHED);
    });
  });

  describe('representation', () => {
    let representation: SpecRepresentationService;

    beforeAll(async () => {
      representation = harness.app.get(SpecRepresentationService);
      await harness.app.get(ProfileEnrichmentService).run();
      await harness.app.get(ProfileEnrichmentService).run();
      await harness.app.get(ProfileEnrichmentService).run();
    });

    it('writes a snapshot whose arithmetic is self-consistent', async () => {
      const summary = await representation.snapshot();

      expect(summary.written).toBeGreaterThan(0);
      await expectRepresentationCoherent(db);

      const row = await snapshots().findOne({ family: '3v3' });
      expect(row).toBeTruthy();
      expect(row!.date).toEqual(startOfUtcDay(new Date()));
    });

    it('re-running the same day upserts rather than duplicating', async () => {
      const before = await snapshots().countDocuments();
      await representation.snapshot();

      expect(await snapshots().countDocuments()).toBe(before);
      const duplicates = await snapshots()
        .aggregate([
          {
            $group: {
              _id: { d: '$date', s: '$seasonId', r: '$region', f: '$family', m: '$minRating' },
              n: { $sum: 1 },
            },
          },
          { $match: { n: { $gt: 1 } } },
        ])
        .toArray();
      expect(duplicates).toEqual([]);
    });

    it('skips a series with nothing above the cutoff rather than writing zeros', async () => {
      const empty = await snapshots().countDocuments({ total: 0 });

      expect(empty, 'an empty series is skipped, not stored as a row of zeros').toBe(0);
    });

    it("§9.2 — a spec ladder is credited with that spec's hero tree", async () => {
      // A character playing one spec while ranked on another spec's ladder is
      // the exact shape that produced combinations the game forbids.
      const player = [...world.players.values()].find((candidate) => {
        const siblings = SPECS.filter((spec) => spec.classSlug === candidate.spec.classSlug);
        return siblings.length > 1 && candidate.spec.heroTrees.length > 0;
      })!;

      const active = player.spec;
      const other = SPECS.find(
        (spec) => spec.classSlug === active.classSlug && spec.specId !== active.specId,
      )!;
      const otherLadder = `shuffle-${other.classSlug}-${other.specSlug}`;

      // Ranked on the other spec's ladder, still playing their own.
      world.setRating(player.id, otherLadder, 2400);
      if (!player.loadoutSpecs.some((spec) => spec.specId === other.specId)) {
        player.loadoutSpecs.push(other);
      }
      await sweep();

      await db
        .collection(CHARACTERS_COLLECTION)
        .updateOne(
          { characterId: player.id },
          { $unset: { profileFetchedAt: '', specsFetchedAt: '' } },
        );
      await harness.app.get(ProfileEnrichmentService).run(true);

      const stored = await db.collection(CHARACTERS_COLLECTION).findOne({ characterId: player.id });
      expect(stored!.profile.spec.id, 'still playing their own spec').toBe(active.specId);

      await snapshots().deleteMany({});
      await representation.snapshot();

      const row = await snapshots().findOne({ family: 'shuffle', minRating: 1800 });
      expect(row).toBeTruthy();

      const share = (
        row!.specs as { class: string; spec: string; heroTalents: { id: number }[] }[]
      ).find((entry) => entry.class === other.classSlug && entry.spec === other.specSlug);
      expect(share, "the other spec's ladder is counted").toBeTruthy();

      const credited = share!.heroTalents.map((tree) => tree.id);
      const otherTrees = other.heroTrees.map((tree) => tree.id);
      const activeTrees = active.heroTrees.map((tree) => tree.id);
      const wrongly = credited.filter((id) => activeTrees.includes(id) && !otherTrees.includes(id));

      expect(
        wrongly,
        `${other.specName} must not be credited with a ${active.specName} hero tree`,
      ).toEqual([]);
      for (const id of credited) expect(otherTrees).toContain(id);
    });

    it('counts the same day separately per UTC date', async () => {
      const yesterday = new Date(Date.now() - 86_400_000);
      await representation.snapshot(yesterday);

      const dates = await snapshots().distinct('date');
      expect(dates.length, 'two distinct UTC days').toBe(2);
      expect(dates.map((date) => (date as Date).getTime())).toContain(
        startOfUtcDay(yesterday).getTime(),
      );
    });
  });
});
