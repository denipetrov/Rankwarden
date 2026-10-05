import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { GUILDS_COLLECTION } from '../src/raid/entities/guild.entity.js';
import { RAIDS_COLLECTION } from '../src/raid/entities/raid.entity.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * The boards read several at once, as production does: every other raid-ranking
 * file reads them one at a time so the order of requests can be asserted.
 *
 * What reading at once puts at risk is the guilds: the same guild is on a
 * raid's world board and its region's, and both are written at the same time.
 */
describe('Raid rankings, boards read at once', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  beforeAll(async () => {
    // Every guild on every difficulty, so each of the 45 boards has guilds on it.
    for (const guild of world.guilds) {
      guild.heroic = guild.progress;
      guild.normal = guild.progress;
    }

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_CONCURRENCY: '5',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    await app.settle();
    // The rankings wait for the first sweep; with enrichment and Mythic+ off,
    // it is the one event that lets them start.
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('stores every board and each guild once, with no write lost to a race', async () => {
    const raids = await db.collection(RAIDS_COLLECTION).find({}).toArray();

    for (const raid of raids) {
      for (const region of ['world', 'us', 'eu', 'kr', 'tw']) {
        expect(Object.keys(raid.guilds[region]).sort(), `${raid.slug}/${region}`).toEqual([
          'heroic',
          'mythic',
          'normal',
        ]);
      }
    }
    const abyss = raids.find((raid) => raid.slug === 'the-venomous-abyss')!;
    expect(abyss.guilds.world.normal).toHaveLength(5);
    expect(await db.collection(GUILDS_COLLECTION).countDocuments()).toBe(5);
    expect(logger.of('warn', /rank/i)).toEqual([]);
    expect(logger.of('error')).toEqual([]);
    await expectInvariants(db, undefined, world);
  });

  it('reads as many boards at once as it is allowed, and no more', async () => {
    app.raiderIo.reset();
    app.raiderIo.delayMs = 15;

    const budget = app.app.get(RaiderIoBudget);
    const before = { other: budget.spent('other'), mplus: budget.spent('mplus') };

    const result = await app.app.get(RaidRankingsService).refreshDue();

    expect(result).toMatchObject({ boards: 15, failed: 0 });
    expect(app.raiderIo.peakInFlight).toBe(5);
    // R6.6: every request, second pages included, is charged to the general
    // allowance and none to the Mythic+ pass.
    const made = app.raiderIo.countMatching('raiding/raid-rankings');
    expect(made).toBeGreaterThan(15);
    expect(budget.spent('other') - before.other).toBe(made);
    expect(budget.spent('mplus')).toBe(before.mplus);
  });

  it('stops soon after an outage begins, without starting every board', async () => {
    app.raiderIo.reset();
    app.raiderIo.delayMs = 15;
    app.raiderIo.failWith('raiding/raid-rankings', { status: 503 });

    const result = await app.app.get(RaidRankingsService).refreshDue();

    expect(result.stopped).toMatch(/boards in a row could not be read/);
    // The five in flight when the third failure lands are all there can be.
    expect(result.failed).toBeLessThanOrEqual(7);
    expect(result.boards).toBe(0);
  });
});
