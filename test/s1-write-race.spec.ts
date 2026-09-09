import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectIdentityUniqueness, expectInvariants } from './support/invariants.js';
import { SPECS, World } from './support/world.js';

/** Eight ladders every player is ranked in, so every bracket races every other. */
const CONTESTED = [
  '2v2',
  '3v3',
  'rbg',
  ...SPECS.slice(0, 5).map((spec) => `shuffle-${spec.classSlug}-${spec.specSlug}`),
];

class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];

  private push(message: unknown) {
    this.lines.push(typeof message === 'string' ? message : String(message));
  }

  log = (m: unknown) => this.push(m);
  error = (m: unknown) => this.push(m);
  warn = (m: unknown) => this.push(m);
  debug = (m: unknown) => this.push(m);
  verbose = (m: unknown) => this.push(m);
}

/**
 * S1.6 — brackets of the same region racing for one character document.
 *
 * §9.7: eight ladders are swept concurrently and all of them now land on the
 * same document, so an upsert can lose the race on the identity index. The
 * document exists by the time the error arrives, so the losing operations are
 * replayed as plain updates.
 *
 * A green run here does *not* prove the replay works: the race is a narrow
 * window in the server, and on this hardware eight concurrent bulk upserts over
 * four hundred shared identities do not open it. What this file proves is the
 * property that matters operationally — real concurrency at the configured
 * limit loses no bracket and produces no duplicate identity. The replay path
 * itself is covered deterministically in
 * `src/leaderboard/character.repository.spec.ts`, by handing the repository the
 * E11000 the driver would have raised.
 */
describe('S1.6 — concurrent brackets on one document', () => {
  const ENV = {
    BLIZZARD_CONCURRENCY: '8',
    LOG_LEVEL: 'debug',
  };

  const logger = new CapturingLogger();
  let harness: TestApp;
  let db: Db;

  beforeAll(async () => {
    const world = World.seed({
      regions: ['us'],
      players: 400,
      seed: 16,
      brackets: CONTESTED,
      multiBracketShare: 1,
    });
    // Everyone in every ladder: maximum contention, which is the only way to
    // make the replay path reliably reachable rather than occasionally so.
    for (const player of world.players.values()) {
      for (const [index, bracket] of CONTESTED.entries()) {
        world.setRating(player.id, bracket, 1500 + ((player.id + index * 37) % 900));
      }
    }

    harness = await bootTestApp(world, ENV, undefined, logger);
    db = harness.app.get(MongoService).db;
    await harness.settle();
    // A uniform delay on every fetch, so all eight ladders come back together
    // and their writes overlap rather than queueing behind each other. Without
    // it the race is real but rare, and a rare race makes a flaky test.
    harness.blizzard.delayMs = 10;
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('drives real concurrency rather than a serialised fixture', () => {
    // Without this the rest of the file would pass over a sweep that never had
    // two brackets in flight at once, which is not the scenario at all.
    expect(harness.blizzard.peakInFlight, 'eight ladders were genuinely in flight').toBe(8);
    expect(logger.lines.some((line) => /Sweep finished/.test(line))).toBe(true);
  });

  it('loses no bracket to the race', async () => {
    const documents = await db.collection(CHARACTERS_COLLECTION).find({}).toArray();

    expect(documents.length).toBe(400);
    for (const document of documents) {
      expect(Object.keys(document.brackets).sort(), `character ${document.characterId}`).toEqual(
        [...CONTESTED].sort(),
      );
    }
  });

  it('writes exactly one document per identity', async () => {
    // Asserted by aggregation rather than by trusting the unique index, which
    // is the thing the race is attacking in the first place.
    await expectIdentityUniqueness(db);
    await expectInvariants(db, harness.world);
  });
});
