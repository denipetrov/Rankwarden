import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import type { CharacterDocument } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { CharacterSyncService } from '../src/sync/character-sync.service.js';
import { characterSyncSchema } from '../src/sync/dto/character-sync.dto.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { World, type WorldPlayer } from './support/world.js';

/**
 * The rating each ladder held before its last write, kept on the character so a
 * reader can show movement. Written on every write, changed or not; the reader
 * decides what counts as movement.
 */
describe('previous rating on each ladder', () => {
  let harness: TestApp;
  let db: Db;
  let player: WorldPlayer;
  /** A spec ladder of the player's, so per-spec ladders are covered as well. */
  let specLadder: string;

  const stored = () =>
    db
      .collection<CharacterDocument>(CHARACTERS_COLLECTION)
      .findOne({ region: 'us', characterId: player.id });

  const sweep = async () => {
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us'], players: 60, seed: 23, multiBracketShare: 1 }),
    );
    db = harness.app.get(MongoService).db;
    player = [...harness.world.players.values()].find(
      (candidate) =>
        candidate.ratings.has('3v3') &&
        [...candidate.ratings.keys()].some((bracket) => bracket.startsWith('shuffle-')),
    )!;
    specLadder = [...player.ratings.keys()].find((bracket) => bracket.startsWith('shuffle-'))!;
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('has none the first time a character appears on a ladder', async () => {
    const character = await stored();

    for (const stats of Object.values(character!.brackets)) {
      expect(stats!.previousRating).toBeNull();
    }
  });

  it('keeps the rating a ladder held before the sweep changed it', async () => {
    const before = await stored();
    const old3v3 = before!.brackets['3v3']!.rating;
    const oldSpec = before!.brackets[specLadder]!.rating;
    harness.world.setRating(player.id, '3v3', old3v3 + 37);
    harness.world.setRating(player.id, specLadder, oldSpec - 12);

    await sweep();

    const after = await stored();
    expect(after!.brackets['3v3']).toMatchObject({ rating: old3v3 + 37, previousRating: old3v3 });
    expect(after!.brackets[specLadder]).toMatchObject({
      rating: oldSpec - 12,
      previousRating: oldSpec,
    });
    // The rest of the document is untouched by the way the write is made.
    expect(after!.characterType).toBe('PvP');
    expect(after!.ratings['3v3']).toBe(old3v3 + 37);
  });

  it('writes it on every sweep, equal to the rating when nothing moved', async () => {
    await sweep();

    const character = await stored();
    for (const stats of Object.values(character!.brackets)) {
      expect(stats!.previousRating).toBe(stats!.rating);
    }
    await expectInvariants(db);
  });

  it('keeps it through the sync endpoint too', async () => {
    const before = (await stored())!;
    const rating = before.brackets['3v3']!.rating;
    const brackets = Object.fromEntries(
      Object.entries(before.brackets).map(([bracket, stats]) => [
        bracket,
        { rating: bracket === '3v3' ? rating + 50 : stats!.rating },
      ]),
    );

    await harness.app.get(CharacterSyncService).sync(
      characterSyncSchema.parse({
        seasonId: before.seasonId,
        region: before.region,
        characterId: before.characterId,
        characterName: before.characterName,
        realmId: before.realmId,
        realmSlug: before.realmSlug,
        faction: before.faction,
        brackets,
      }),
    );

    expect((await stored())!.brackets['3v3']).toMatchObject({
      rating: rating + 50,
      previousRating: rating,
    });
    await expectInvariants(db);
  });
});
