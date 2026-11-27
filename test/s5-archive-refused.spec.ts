import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ArchiveService } from '../src/archive/archive.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { CORE_BRACKETS, World } from './support/world.js';
import { ARCHIVE_SEASONS_COLLECTION } from '../src/database/collections.js';

const SEASON = 42;
/** The season Blizzard refuses, in the middle of the backlog. */
const REFUSED = 41;
const OLDEST = 40;

/**
 * A season Blizzard answers 403 for — as it does seasons 22–26 for real — is
 * refused for good, like a 404: recorded once as unarchivable, and never asked
 * for again. Treating it as transient retried those five seasons in every
 * region on every hourly tick, forever.
 */
describe('S5 — a season Blizzard refuses with 403', () => {
  let harness: TestApp;
  let db: Db;

  const marker = (seasonId: number) =>
    db.collection(ARCHIVE_SEASONS_COLLECTION).findOne({ seasonId, region: 'us' });

  beforeAll(async () => {
    const world = World.seed({
      regions: ['us'],
      players: 12,
      seed: 52,
      season: SEASON,
      brackets: [...CORE_BRACKETS],
    });
    world.fail('us', `brackets:${REFUSED}`, 403);
    world.endSeason('us', new Date('2026-09-01T05:00:00.000Z'));

    harness = await bootTestApp(world, {
      SEASON_REFRESH_ENABLED: 'true',
      ARCHIVE_ENABLED: 'true',
      ARCHIVE_MAX_ENTRIES_PER_BRACKET: '5',
      ARCHIVE_MIN_SEASON: String(OLDEST),
      ARCHIVE_MAX_SEASON: String(SEASON),
    });
    db = harness.app.get(MongoService).db;
    await harness.settle();
    // The sweep warms the coordinator up, which is what releases the archive.
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('records the refused season as unarchivable, and archives the ones behind it', async () => {
    const refused = await marker(REFUSED);

    expect(refused, 'the refused season is recorded rather than retried').toBeTruthy();
    expect(refused!.unarchivable).toBe(true);
    expect(String(refused!.lastError)).toMatch(/403/);

    for (const seasonId of [SEASON, OLDEST]) {
      expect((await marker(seasonId))?.failedBrackets, `season ${seasonId}`).toEqual([]);
    }
    expect(await harness.app.get(ArchiveService).nextPending(), 'the backlog is empty').toBeNull();
  });

  it('never asks Blizzard for it again', async () => {
    harness.blizzard.reset();
    await harness.app.get(ArchiveService).nextPending();

    expect(
      harness.blizzard.requests.filter((request) => request.path.includes(`pvp-season/${REFUSED}`)),
    ).toEqual([]);
  });
});
