import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { GUILDS_COLLECTION } from '../src/raid/entities/guild.entity.js';
import { RAIDS_COLLECTION } from '../src/raid/entities/raid.entity.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * Raid plan R2.7 and R2.8 — a configuration other than the default: a `cn`
 * board asked for, and a difficulty that was once read and no longer is.
 *
 * Its own file because the boards and difficulties are configuration.
 */
describe('Raid plan R2.7-R2.8 — configured boards', () => {
  let app: TestApp;
  let db: Db;
  let rankings: RaidRankingsService;
  const world = new MplusWorld();
  const stale = new Date('2026-09-01T00:00:00Z');
  const oldBoard = [
    { rank: 1, regionRank: 1, guildId: 1047044, encountersPulled: [], encountersDefeated: [] },
  ];

  const raid = async (slug: string) => (await db.collection(RAIDS_COLLECTION).findOne({ slug }))!;

  beforeAll(async () => {
    // Every guild is on the Heroic boards too.
    for (const guild of world.guilds) guild.heroic = guild.progress;

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_REGIONS: 'world,cn',
        RAID_RANKINGS_DIFFICULTIES: 'mythic,heroic',
      },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    await app.app.get(RaidCatalogueService).refreshIfDue();

    // A Normal board, read back when Normal was configured.
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne(
        { slug: 'the-venomous-abyss' },
        { $set: { 'guilds.world.normal': oldBoard, 'guildsUpdatedAt.world.normal': stale } },
      );
    await db.collection(GUILDS_COLLECTION).insertOne({
      id: 1047044,
      name: 'Echo',
      faction: 'horde',
      logo: null,
      region: 'eu',
      realm: null,
      updatedAt: stale,
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('R2.7 reads a cn board when one is configured, and only the boards configured', async () => {
    const result = await rankings.refreshDue();

    // Three raids, two boards, two difficulties.
    expect(result).toMatchObject({ boards: 12, failed: 0 });
    const asked = new Set(
      app.raiderIo.requests
        .filter((request) => request.path === 'raiding/raid-rankings')
        .map((request) => `${request.region}/${request.params.difficulty}`),
    );
    expect([...asked].sort()).toEqual(['cn/heroic', 'cn/mythic', 'world/heroic', 'world/mythic']);

    const abyss = await raid('the-venomous-abyss');
    expect(abyss.guilds.cn.mythic).toEqual([
      expect.objectContaining({ rank: 1, regionRank: 1, guildId: 3001 }),
    ]);
    expect(abyss.guilds.cn.heroic).toHaveLength(1);
    expect(Object.keys(abyss.guilds).sort()).toEqual(['cn', 'world']);
  });

  it('R2.8 a board of a difficulty no longer configured stays as it was, and is never refreshed', async () => {
    app.raiderIo.reset();
    await rankings.refreshDue();
    await rankings.refreshRaid('the-venomous-abyss');

    expect(
      app.raiderIo.requests.filter((request) => request.params.difficulty === 'normal'),
    ).toEqual([]);
    const abyss = await raid('the-venomous-abyss');
    // Stale, and not removed: nothing reads it again, and nothing deletes it.
    expect(abyss.guilds.world.normal).toEqual(oldBoard);
    expect(abyss.guildsUpdatedAt.world.normal).toEqual(stale);
    expect(Object.keys(abyss.guilds.world).sort()).toEqual(['heroic', 'mythic', 'normal']);

    await expectInvariants(db);
  });
});
