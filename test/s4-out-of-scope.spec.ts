import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RATING_FAMILIES, ratingFamilyOf } from '../src/blizzard/blizzard.constants.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectNoUnrankedCharacters } from './support/invariants.js';
import { World, type WorldPlayer } from './support/world.js';

/**
 * S4 — falling out of scope.
 *
 * Three destructive cleanup paths, none of which had automated coverage. The
 * failure that matters most is not "stale data survives" but "a failing sweep
 * deletes a healthy region", so half of these assert that deletion does *not*
 * happen.
 */
describe('S4 — falling out of scope', () => {
  let harness: TestApp;
  let db: Db;
  let sweep: () => Promise<void>;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const rows = (family: (typeof RATING_FAMILIES)[number]) =>
    db.collection(RATING_COLLECTIONS[family]);

  /** A player ranked in at least `count` brackets, so drops leave survivors. */
  const pickPlayer = (count: number): WorldPlayer => {
    const found = [...harness.world.players.values()].find(
      (player) => player.region === 'us' && player.ratings.size >= count && !player.deleted,
    );
    if (!found) throw new Error(`no us player with ${count}+ brackets in this world`);

    return found;
  };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 120, seed: 4, multiBracketShare: 0.6 }),
    );
    db = harness.app.get(MongoService).db;
    const leaderboards = harness.app.get(LeaderboardService);
    sweep = async () => {
      const result = await leaderboards.sweep();
      expect(result, 'sweep must not be skipped').not.toBeNull();
    };

    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  beforeEach(() => {
    harness.world.clearFailures();
    harness.blizzard.reset();
  });

  it('S4.1 — leaving one ladder clears only that bracket', async () => {
    const player = pickPlayer(3);
    const [bracket] = [...player.ratings.keys()];
    const family = ratingFamilyOf(bracket)!;
    const survivors = [...player.ratings.keys()].filter((key) => key !== bracket);

    harness.world.dropFromBracket(player.id, bracket);
    await sweep();

    const doc = await characters().findOne({ characterId: player.id, region: 'us' });

    expect(doc, 'the character survives losing one ladder').not.toBeNull();
    expect(doc!.brackets).not.toHaveProperty(bracket);
    expect(doc!.ratings).not.toHaveProperty(bracket);
    for (const kept of survivors) expect(doc!.brackets).toHaveProperty(kept);

    expect(await rows(family).countDocuments({ characterId: player.id, bracket })).toBe(0);
    await expectInvariants(db, harness.world);
  });

  it('S4.2 — leaving every ladder deletes the character and all its rows', async () => {
    const player = pickPlayer(2);

    harness.world.dropFromAllBrackets(player.id);
    const before = await characters().countDocuments();
    await sweep();

    expect(await characters().findOne({ characterId: player.id, region: 'us' })).toBeNull();
    expect(await characters().countDocuments()).toBe(before - 1);

    for (const family of RATING_FAMILIES) {
      expect(
        await rows(family).countDocuments({ characterId: player.id }),
        RATING_COLLECTIONS[family],
      ).toBe(0);
    }

    await expectInvariants(db, harness.world);
    await expectNoUnrankedCharacters(db);
  });

  it('S4.4 — rows for a character deleted out of band are reconciled away', async () => {
    const player = pickPlayer(2);
    const familiesHeld = new Set(
      [...player.ratings.keys()].map((bracket) => ratingFamilyOf(bracket)!),
    );

    // Delete the document only, leaving its rows behind: the state a crash
    // between the two deletes would produce.
    await characters().deleteOne({ characterId: player.id, region: 'us' });
    const orphaned = await rows([...familiesHeld][0]).countDocuments({ characterId: player.id });
    expect(orphaned, 'the fixture must leave rows behind').toBeGreaterThan(0);

    await sweep();

    // The sweep re-creates the character from the ladder, so what matters is
    // that no row was left pointing at nothing at any stage.
    await expectInvariants(db, harness.world);
  });

  it('S4.5 / S4.6 — a retired ladder is cleared from rows and from characters', async () => {
    const player = pickPlayer(3);
    const bracket = [...player.ratings.keys()].find((key) => key.startsWith('shuffle-'));
    expect(bracket, 'need a spec ladder to retire').toBeDefined();
    const family = ratingFamilyOf(bracket!)!;

    harness.world.retireBracket('us', bracket!);
    await sweep();

    // S4.5 — the flat rows go, even though pruneBracket never visited it.
    expect(await rows(family).countDocuments({ region: 'us', bracket: bracket! })).toBe(0);

    // S4.6 — and so do the keys on the character document (F1).
    const stillCarrying = await characters().countDocuments({
      region: 'us',
      [`brackets.${bracket!}`]: { $exists: true },
    });
    expect(stillCarrying, `no character may keep the retired ${bracket!}`).toBe(0);
    expect(
      await characters().countDocuments({
        region: 'us',
        [`ratings.${bracket!}`]: { $exists: true },
      }),
    ).toBe(0);

    // Other shuffle ladders are untouched.
    expect(await rows(family).countDocuments({ region: 'us' })).toBeGreaterThan(0);
    await expectInvariants(db, harness.world);
    await expectNoUnrankedCharacters(db);

    harness.world.publishBracket('us', bracket!);
    await sweep();
  });

  it('S4.6b — a character ranked only in a retired ladder is deleted', async () => {
    const player = pickPlayer(1);
    const [keep] = [...player.ratings.keys()].filter((key) => key.startsWith('blitz-'));
    expect(keep, 'need a blitz ladder for this player').toBeDefined();

    // Strip them back to exactly one ladder, then retire it.
    for (const bracket of [...player.ratings.keys()]) {
      if (bracket !== keep) harness.world.dropFromBracket(player.id, bracket);
    }
    await sweep();
    expect(await characters().findOne({ characterId: player.id, region: 'us' })).not.toBeNull();

    harness.world.retireBracket('us', keep);
    await sweep();

    expect(
      await characters().findOne({ characterId: player.id, region: 'us' }),
      'a character left ranking only in a retired ladder must be deleted',
    ).toBeNull();

    await expectInvariants(db, harness.world);
    await expectNoUnrankedCharacters(db);

    harness.world.publishBracket('us', keep);
    harness.world.dropFromAllBrackets(player.id);
    await sweep();
  });

  it('S4.7 — a region whose bracket index fails is left completely alone', async () => {
    const snapshot = {
      characters: await characters().countDocuments({ region: 'eu' }),
      rows: await rows('3v3').countDocuments({ region: 'eu' }),
      sample: await characters().find({ region: 'eu' }).sort({ characterId: 1 }).limit(5).toArray(),
    };

    harness.world.fail('eu', 'brackets', 500);
    const result = await harness.app.get(LeaderboardService).sweep();

    // No eu jobs were built, so eu is absent from the cleanup entirely.
    expect(result!.jobs.every((job) => job.region === 'us')).toBe(true);
    expect(await characters().countDocuments({ region: 'eu' })).toBe(snapshot.characters);
    expect(await rows('3v3').countDocuments({ region: 'eu' })).toBe(snapshot.rows);

    const after = await characters()
      .find({ region: 'eu' })
      .sort({ characterId: 1 })
      .limit(5)
      .toArray();
    expect(after.map((doc) => doc.characterId)).toEqual(
      snapshot.sample.map((doc) => doc.characterId),
    );
    expect(after.map((doc) => doc.ratings)).toEqual(snapshot.sample.map((doc) => doc.ratings));

    harness.world.clearFailures();
    await sweep();
  });

  it('S4.8 — a single failed bracket does not drop its players', async () => {
    const before = await characters().countDocuments({ region: 'us' });
    const rowsBefore = await rows('3v3').countDocuments({ region: 'us', bracket: '3v3' });
    expect(rowsBefore).toBeGreaterThan(0);

    harness.world.fail('us', '3v3', 500);
    const result = await harness.app.get(LeaderboardService).sweep();

    expect(result!.failed).toBe(1);
    expect(result!.removedCharacters).toBe(0);
    // The bracket was never pruned, so its data survives rather than being
    // mistaken for players who left the ladder.
    expect(await rows('3v3').countDocuments({ region: 'us', bracket: '3v3' })).toBe(rowsBefore);
    expect(await characters().countDocuments({ region: 'us' })).toBe(before);

    harness.world.clearFailures();
    await sweep();
  });

  it('S4.9 — every bracket failing deletes nothing', async () => {
    const before = {
      characters: await characters().countDocuments(),
      rows: await rows('3v3').countDocuments(),
    };

    for (const bracket of harness.world.brackets('us')) harness.world.fail('us', bracket, 503);
    for (const bracket of harness.world.brackets('eu')) harness.world.fail('eu', bracket, 503);

    const result = await harness.app.get(LeaderboardService).sweep();

    expect(result!.failed).toBe(result!.jobs.length);
    expect(result!.removedCharacters).toBe(0);
    expect(await characters().countDocuments()).toBe(before.characters);
    expect(await rows('3v3').countDocuments()).toBe(before.rows);

    harness.world.clearFailures();
    await sweep();
  });

  it('S4.10 — an empty ladder is honoured as empty, not treated as a failure', async () => {
    // Derive the ladder from live state rather than assuming one: earlier cases
    // in this file mutate the same world, so a hardcoded bracket goes stale.
    const [busiest] = await rows('3v3')
      .aggregate<{ _id: string; n: number }>([
        { $match: { region: 'us' } },
        { $group: { _id: '$bracket', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    expect(busiest, 'need a populated core ladder').toBeDefined();
    const bracket = busiest._id;

    const players = [...harness.world.players.values()].filter(
      (player) => player.region === 'us' && player.ratings.has(bracket),
    );
    expect(players.length).toBeGreaterThan(0);

    for (const player of players) harness.world.dropFromBracket(player.id, bracket);
    const result = await harness.app.get(LeaderboardService).sweep();

    // An empty 200 is not a failure, and it must be acted on: everyone leaves.
    expect(result!.failed).toBe(0);
    expect(await rows('3v3').countDocuments({ region: 'us', bracket })).toBe(0);
    expect(
      await characters().countDocuments({
        region: 'us',
        [`brackets.${bracket}`]: { $exists: true },
      }),
    ).toBe(0);

    await expectInvariants(db, harness.world);
    await expectNoUnrankedCharacters(db);
  });

  it('S4.11 — deletion never crosses a region boundary', async () => {
    const euBefore = await characters().countDocuments({ region: 'eu' });
    const player = pickPlayer(1);

    harness.world.dropFromAllBrackets(player.id);
    await sweep();

    expect(await characters().countDocuments({ region: 'eu' })).toBe(euBefore);
    await expectInvariants(db, harness.world);
  });
});
