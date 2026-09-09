import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { World } from './support/world.js';

/** Comfortably past the 1,000-operation bulk chunk, with a remainder. */
const LADDER_SIZE = 12_000;

/**
 * S7.9 — a ladder far larger than one bulk chunk.
 *
 * Real 3v3 and Solo Shuffle ladders run into five figures, and both repositories
 * write in chunks of a thousand. A boundary bug there loses a slice of the
 * ladder silently: the sweep reports success, the board is short, and nothing
 * anywhere says so.
 *
 * Its own file because twelve thousand characters make every other case in a
 * shared file slower without making any of them stronger.
 */
describe('S7.9 — a twelve thousand entry ladder', () => {
  let harness: TestApp;
  let db: Db;
  let written = 0;

  const characters = () => db.collection(CHARACTERS_COLLECTION);

  beforeAll(async () => {
    const world = World.seed({
      regions: ['us'],
      players: LADDER_SIZE,
      seed: 79,
      brackets: ['3v3'],
      multiBracketShare: 0,
    });
    for (const [index, player] of [...world.players.values()].entries()) {
      world.setRating(player.id, '3v3', 1400 + (index % 1_400));
    }

    harness = await bootTestApp(world, { BLIZZARD_CONCURRENCY: '2' });
    db = harness.app.get(MongoService).db;
    await harness.settle();

    const result = await harness.app.get(LeaderboardService).sweep();
    expect(result).not.toBeNull();
    written = result!.jobs.find((job) => job.bracket === '3v3')!.entries;
  }, 120_000);

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('writes every entry, remainder chunk included', async () => {
    expect(written, 'the sweep reports what it actually wrote').toBe(LADDER_SIZE);
    expect(await characters().countDocuments({ region: 'us' })).toBe(LADDER_SIZE);
    expect(
      await db.collection(RATING_COLLECTIONS['3v3']).countDocuments({ region: 'us' }),
      'the flat rows are chunked independently and must match',
    ).toBe(LADDER_SIZE);
  });

  it('keeps the ordering intact across chunk boundaries', async () => {
    // A chunking bug that drops or duplicates a slice shows up as a rank gap
    // rather than as a wrong count, so the ranks are checked as well.
    const ranks = await characters()
      .find({ region: 'us' }, { projection: { 'brackets.3v3.rank': 1 } })
      .toArray();
    const seen = new Set(ranks.map((row) => row.brackets['3v3'].rank));

    expect(seen.size, 'every rank from 1 to 12,000 appears exactly once').toBe(LADDER_SIZE);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(LADDER_SIZE);
  });

  it('holds every invariant at this size', async () => {
    await expectInvariants(db, harness.world);
  }, 120_000);
});
