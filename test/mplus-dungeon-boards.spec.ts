import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectMplusStoredMatchesServed } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { member, MplusWorld, WORLD_DUNGEONS } from './support/mplus-world.js';
import { World } from './support/world.js';
import {
  MPLUS_CHARACTERS_COLLECTION,
  MPLUS_DUNGEONS_COLLECTION,
} from '../src/database/collections.js';

const SEASON = 'season-mn-2';
const MAX_PAGES = 5;

/**
 * The live pass reads each dungeon's own board rather than the all-dungeons one.
 *
 * The season lists the three dungeons the world plays. US holds 240 runs, 80 a
 * dungeon, above `Deep`'s three runs — one in each dungeon at 700. A pass reads
 * five pages (100 runs) of a board: on the all-dungeons board Deep's runs rank
 * 241-243 and are never read, while on each dungeon's own board Deep ranks 81
 * and is. That gap is the whole point of reading per dungeon.
 */
describe('Mythic+ dungeon boards', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();
  const deep = member(7_001, 'Deep');

  const runsRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/runs');

  beforeAll(async () => {
    world.seasons.find((season) => season.slug === SEASON)!.dungeons = WORLD_DUNGEONS.length;
    world.seed('us', 240, 1_000, SEASON);
    WORLD_DUNGEONS.forEach((_dungeon, index) =>
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 700,
        dungeon: index,
        members: [
          deep,
          ...[1, 2, 3, 4].map((slot) => member(7_100 + index * 10 + slot, `D${index}${slot}`)),
        ],
      }),
    );

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      // Configured least wanted first: the pass reorders them.
      { RAIDERIO_REGIONS: 'tw,cn,us' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reads regions most wanted first: us, then cn, then tw', async () => {
    const result = (await app.app.get(MplusService).sweep())!;

    expect(result.regions.map((region) => region.region)).toEqual(['us', 'cn', 'tw']);
    expect(runsRequests()[0].region).toBe('us');
    expect(runsRequests().at(-1)!.region).toBe('tw');
  });

  it("reads each dungeon's own board in the season's order, deep enough to complete Deep", async () => {
    app.raiderIo.reset();
    const result = (await app.app.get(MplusService).sweep())!;
    const us = result.regions.find((region) => region.region === 'us')!;

    expect(us.boards).toEqual(WORLD_DUNGEONS.map((dungeon) => dungeon.slug));
    expect(us.pagesPlanned).toBe(WORLD_DUNGEONS.length * MAX_PAGES);
    expect([
      ...new Set(
        runsRequests()
          .filter((request) => request.region === 'us')
          .map((request) => request.params.dungeon),
      ),
    ]).toEqual(WORLD_DUNGEONS.map((dungeon) => dungeon.slug));

    const stored = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ season: SEASON, key: 'us/stormrage/deep' });
    expect(stored, 'ranked 241-243 overall, 81 in each dungeon').not.toBeNull();
    expect(stored!.dungeonsCovered).toBe(3);
    expect(stored!.isFullyCovered).toBe(true);
    expect(stored!.mythicScore).toBe(2_100);

    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: MAX_PAGES,
    });
    await expectInvariants(db);
  });

  it('falls back to the all-dungeons board when the catalogue cannot name a dungeon', async () => {
    const dungeons = db.collection(MPLUS_DUNGEONS_COLLECTION);
    const missing = (await dungeons.findOne({ id: WORLD_DUNGEONS[1].id }))!;
    await dungeons.deleteOne({ id: WORLD_DUNGEONS[1].id });
    app.raiderIo.reset();
    logger.clear();

    try {
      const result = (await app.app.get(MplusService).sweep())!;
      const us = result.regions.find((region) => region.region === 'us')!;

      // Read, not skipped: the region stays on the board, just less deep.
      expect(us.boards).toEqual(['all']);
      expect(us.stoppedEarly).toBeNull();
      expect(us.runs).toBe(MAX_PAGES * 20);
      expect(new Set(runsRequests().map((request) => request.params.dungeon))).toEqual(
        new Set(['all']),
      );
      expect(
        logger.of(
          'warn',
          /cannot name every dungeon of season-mn-2; reading us from the all-dungeons board/,
        ),
      ).toHaveLength(1);
    } finally {
      await dungeons.insertOne(missing);
    }
  });
});
