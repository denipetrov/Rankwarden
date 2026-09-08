import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import { ArchiveService } from '../src/archive/archive.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { SpecRepresentationService } from '../src/representation/spec-representation.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { CHARACTER_INDEXES } from './support/invariants.js';
import { World } from './support/world.js';

const FINISHED = 42;
const CURRENT = 43;

/**
 * S9 — restart and resumption.
 *
 * Historical standings never change, so a restart must never spend the quota
 * re-fetching them. The mechanisms exist; what had never been tested is whether
 * they hold across an actual process boundary, and whether the F8 fix stops the
 * probe from also skipping data that was never stored.
 */
describe('S9 — restart and resumption', () => {
  // Bounded to the one finished season, because the world seeds two more behind
  // it and this file is about restart behaviour, not backlog ordering.
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    ARCHIVE_MIN_SEASON: String(FINISHED),
    ARCHIVE_MAX_SEASON: String(FINISHED),
  };

  let harness: TestApp;
  let db: Db;
  let dbName: string;
  let world: World;

  const entries = () => db.collection(ARCHIVE_ENTRIES_COLLECTION);
  const markers = () => db.collection(ARCHIVE_SEASONS_COLLECTION);

  /** Closes the app and boots a new one against the same database. */
  const restart = async () => {
    await harness.close();
    harness = await bootTestApp(world, { ...ENV, MONGODB_DB: dbName });
    db = harness.app.get(MongoService).db;
    await harness.settle();
    harness.blizzard.reset();
  };

  /** Ladder fetches only — the bracket index shares the same path fragment. */
  const ladderFetches = () =>
    harness.blizzard.requests.filter(
      (request) =>
        request.path.includes('/pvp-leaderboard/') &&
        !request.path.endsWith('/pvp-leaderboard/index'),
    ).length;

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 40, seed: 9, season: FINISHED });
    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    dbName = harness.dbName;

    await harness.app.get(LeaderboardService).sweep();

    // Roll over so season 42 is finished and therefore archivable. The rollover
    // clears every ladder, so put ratings back or the archive stores nothing.
    world.rollover('us', CURRENT, new Date('2026-08-18T15:00:00.000Z'));
    // Every published ladder gets at least one entry. A bracket that is
    // legitimately empty stores no rows, and the completeness probe cannot tell
    // that apart from a bracket that was never fetched — see the empty-ladder
    // case at the end of this file.
    const players = [...world.players.values()];
    for (const [index, bracket] of world.brackets('us').entries()) {
      world.setRating(players[index % players.length].id, bracket, 1800 + index);
    }
    await harness.app.get(LeaderboardService).sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('archives the finished season once', async () => {
    const pending = await harness.app.get(ArchiveService).nextPending();
    expect(pending).toEqual({ seasonId: FINISHED, region: 'us' });

    const result = await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');

    expect(result.failedBrackets).toEqual([]);
    expect(result.entries).toBeGreaterThan(0);
    expect(await entries().countDocuments({ seasonId: FINISHED, region: 'us' })).toBe(
      result.entries,
    );
    expect(await markers().countDocuments({ seasonId: FINISHED, region: 'us' })).toBe(1);
  });

  it('S9.1 — a restart re-fetches nothing for a completed season', async () => {
    await restart();

    const pending = await harness.app.get(ArchiveService).nextPending();

    expect(pending, 'a completed season is never offered again').toBeNull();
    expect(ladderFetches(), 'and no ladder is fetched to find that out').toBe(0);
  });

  it('S9.2 — repeated restarts leave the archive byte-identical', async () => {
    const fingerprint = async () =>
      (
        await entries()
          .find({}, { projection: { _id: 0, bracket: 1, characterId: 1, rating: 1 } })
          .sort({ bracket: 1, characterId: 1 })
          .toArray()
      )
        .map((row) => `${row.bracket}:${row.characterId}:${row.rating}`)
        .join('|');

    const before = await fingerprint();
    expect(before.length).toBeGreaterThan(0);

    let fetches = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await restart();
      await harness.app.get(ArchiveService).nextPending();
      fetches += ladderFetches();
    }

    expect(await fingerprint(), 'the stored history must not move').toBe(before);
    expect(fetches, 'no ladder is re-fetched across any restart').toBe(0);
  });

  it('S9.3 — a dropped markers collection is recovered without re-fetching', async () => {
    const stored = await entries().countDocuments({ seasonId: FINISHED, region: 'us' });
    await markers().deleteMany({});
    await restart();

    const pending = await harness.app.get(ArchiveService).nextPending();

    expect(pending, 'the stored rows are recognised and the marker written back').toBeNull();
    expect(await markers().countDocuments({ seasonId: FINISHED, region: 'us' })).toBe(1);
    expect(await entries().countDocuments({ seasonId: FINISHED, region: 'us' })).toBe(stored);
    // The probe costs a bracket index and a season record, never the ladders.
    expect(ladderFetches()).toBe(0);
  });

  it('S9.4 — a crash mid-archive is not mistaken for a complete season', async () => {
    // A process killed partway leaves rows for some brackets and no marker.
    const kept = ['3v3', '2v2'];
    await entries().deleteMany({ seasonId: FINISHED, region: 'us', bracket: { $nin: kept } });
    await markers().deleteMany({});
    const partial = await entries().countDocuments({ seasonId: FINISHED, region: 'us' });
    expect(partial).toBeGreaterThan(0);

    await restart();
    const pending = await harness.app.get(ArchiveService).nextPending();

    // Before the F8 fix the probe sampled only brackets that were present, so it
    // always found rows and marked the season complete forever.
    expect(pending, 'a partial season must stay pending').toEqual({
      seasonId: FINISHED,
      region: 'us',
    });

    const marker = await markers().findOne({ seasonId: FINISHED, region: 'us' });
    expect(marker?.failedBrackets?.length, 'the shortfall is recorded').toBeGreaterThan(0);
  });

  it('S9.5 — the retry fetches only the brackets that are outstanding', async () => {
    const kept = await entries().distinct('bracket', { seasonId: FINISHED, region: 'us' });
    const published = world.brackets('us').filter((bracket) => !bracket.endsWith('-overall'));
    const outstanding = published.length - kept.length;
    expect(outstanding).toBeGreaterThan(0);

    harness.blizzard.reset();
    const result = await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');

    expect(ladderFetches(), 'the brackets already stored must not be fetched again').toBe(
      outstanding,
    );
    expect(result.failedBrackets).toEqual([]);

    const after = await entries().distinct('bracket', { seasonId: FINISHED, region: 'us' });
    expect(after.length).toBe(published.length);
  });

  it('S9.6 — re-archiving can never duplicate a row', async () => {
    const before = await entries().countDocuments({ seasonId: FINISHED, region: 'us' });

    await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');

    expect(await entries().countDocuments({ seasonId: FINISHED, region: 'us' })).toBe(before);
    const duplicates = await entries()
      .aggregate([
        { $group: { _id: { b: '$bracket', c: '$characterId' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    expect(duplicates).toEqual([]);
  });

  it('S9.7 — a restart mid-day does not recompute the snapshot', async () => {
    const representation = harness.app.get(SpecRepresentationService);
    await representation.snapshot();

    const before = await db
      .collection(SPEC_REPRESENTATION_COLLECTION)
      .find({}, { projection: { _id: 0, computedAt: 1, seasonId: 1 } })
      .sort({ computedAt: 1 })
      .toArray();
    expect(before.length).toBeGreaterThan(0);

    await restart();

    expect(
      await harness.app.get(SpecRepresentationService).isSnapshotDue(),
      "today's snapshot already exists",
    ).toBe(false);

    const after = await db
      .collection(SPEC_REPRESENTATION_COLLECTION)
      .find({}, { projection: { _id: 0, computedAt: 1, seasonId: 1 } })
      .sort({ computedAt: 1 })
      .toArray();
    expect(after.map((row) => row.computedAt)).toEqual(before.map((row) => row.computedAt));
  });

  it('S9.8 — a restart does not re-enrich recently enriched characters', async () => {
    const enrichment = harness.app.get(ProfileEnrichmentService);
    await enrichment.run();

    const enriched = await db
      .collection(CHARACTERS_COLLECTION)
      .countDocuments({ profileStatus: 'ok' });
    expect(enriched).toBeGreaterThan(0);

    const stamps = await db
      .collection(CHARACTERS_COLLECTION)
      .find({ profileStatus: 'ok' }, { projection: { characterId: 1, specsFetchedAt: 1 } })
      .sort({ characterId: 1 })
      .toArray();

    await restart();
    await harness.app.get(ProfileEnrichmentService).run();

    const after = await db
      .collection(CHARACTERS_COLLECTION)
      .find(
        { characterId: { $in: stamps.map((doc) => doc.characterId) } },
        { projection: { characterId: 1, specsFetchedAt: 1 } },
      )
      .sort({ characterId: 1 })
      .toArray();

    // Progress lives in the documents, not in the process.
    expect(after.map((doc) => doc.specsFetchedAt)).toEqual(stamps.map((doc) => doc.specsFetchedAt));
  });

  it('S9.11 — boot maintenance is idempotent across repeated restarts', async () => {
    const inventory = async () =>
      (await db.collection(CHARACTERS_COLLECTION).indexes()).map((index) => index.name).sort();

    const before = await inventory();
    expect(before).toEqual([...CHARACTER_INDEXES].sort());

    for (let cycle = 0; cycle < 3; cycle += 1) await restart();

    expect(await inventory(), 'the index inventory must not drift').toEqual(before);
  });

  /**
   * A season with a legitimately empty ladder can never be adopted from its
   * stored rows.
   *
   * The completeness probe compares the brackets that have rows against the
   * brackets Blizzard publishes. A ladder nobody qualified for stores nothing,
   * which is indistinguishable from a ladder that was never fetched — so the
   * season is judged partial forever and the cheap recovery path the probe
   * exists for is defeated. Recovery then costs a full re-fetch of every empty
   * bracket, which is exactly the ~80 requests the probe was built to avoid.
   *
   * Realistic on a small region: plenty of the 80 spec ladders in tw or kr
   * finish a season with nobody on them. Not data loss, and it self-heals after
   * one wasteful pass, which is why it is low severity rather than urgent.
   */
  it.fails('ISSUE-4 — an empty ladder must not make a season unadoptable', async () => {
    const empty = 'blitz-warrior-protection';
    for (const player of world.players.values()) player.ratings.delete(empty);

    await entries().deleteMany({});
    await markers().deleteMany({});
    await harness.app.get(ArchiveService).archiveSeason(FINISHED, 'us');

    const marker = await markers().findOne({ seasonId: FINISHED, region: 'us' });
    expect(marker!.failedBrackets, 'a real archive run knows the ladder was simply empty').toEqual(
      [],
    );
    expect(await entries().countDocuments({ bracket: empty })).toBe(0);

    // Now lose the marker, which is the whole scenario the probe handles.
    await markers().deleteMany({});
    await restart();

    const pending = await harness.app.get(ArchiveService).nextPending();

    expect(
      pending,
      'the stored rows are complete, so the season should be adopted without re-fetching',
    ).toBeNull();
  });
});
