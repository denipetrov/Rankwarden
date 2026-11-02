import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { BOSSES_COLLECTION } from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const REGIONS = ['world', 'us', 'eu', 'kr', 'tw'];

/**
 * The bosses: every encounter of every raid as a document of its own in
 * `bosses`, written by the catalogue, and on each the first fifty guilds to
 * kill it, per board — read by the raid rankings job in the same run as the
 * raid boards.
 *
 * Mythic only. The world's raids have five bosses between them: The Venomous
 * Abyss (open) has two with five guilds on them, Manaforge Omega two with two,
 * and Tier MN 1 one with nobody.
 */
describe('Boss rankings', () => {
  let app: TestApp;
  let db: Db;
  let rankings: RaidRankingsService;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const bossRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/boss-rankings');
  const asked = () =>
    bossRequests().map(
      (request) => `${request.params.raid}/${request.params.boss}/${request.region}`,
    );
  const boss = async (slug: string) =>
    (await db.collection(BOSSES_COLLECTION).findOne({ slug }, { projection: { _id: 0 } }))!;
  const board = async (slug: string, region: string) =>
    (await boss(slug)).bossRankings?.[region]?.mythic as Record<string, unknown>[] | undefined;

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        BOSS_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_DIFFICULTIES: 'mythic',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    // The rankings, bosses included, wait for the first sweep.
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
    await app.listen();
  });

  afterEach(() => {
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('keeps every boss of every raid as a document of its own, under its raid', async () => {
    const bosses = await db
      .collection(BOSSES_COLLECTION)
      .find({}, { projection: { _id: 0, id: 1, raidId: 1, name: 1, slug: 1 } })
      .sort({ id: 1 })
      .toArray();

    expect(bosses).toEqual([
      { id: 197124, raidId: 16178, name: 'Plexus Sentinel', slug: 'plexus-sentinel' },
      { id: 197131, raidId: 16178, name: 'Dimensius', slug: 'dimensius' },
      { id: 200001, raidId: 16340, name: 'First Boss', slug: 'first-boss' },
      { id: 210001, raidId: 16915, name: 'Gatekeeper', slug: 'gatekeeper' },
      { id: 210008, raidId: 16915, name: 'The Abyssal Queen', slug: 'the-abyssal-queen' },
    ]);

    const indexes = Object.fromEntries(
      (await db.collection(BOSSES_COLLECTION).indexes())
        .filter((index) => index.name !== '_id_')
        .map((index) => [index.name, { key: index.key, unique: index.unique === true }]),
    );
    expect(indexes).toEqual({
      boss_identity: { key: { id: 1 }, unique: true },
      boss_raid_slug: { key: { raidId: 1, slug: 1 }, unique: false },
    });
  });

  it('reads every boss on every board in the first run, one request a board', async () => {
    // Read during beforeAll; a run by hand asks again for the open raid's bosses.
    const result = await rankings.refreshDue();

    expect(asked()).toEqual([
      ...REGIONS.map((region) => `the-venomous-abyss/gatekeeper/${region}`),
      ...REGIONS.map((region) => `the-venomous-abyss/the-abyssal-queen/${region}`),
    ]);
    for (const request of bossRequests()) {
      expect(request.params).toEqual({
        raid: 'the-venomous-abyss',
        boss: expect.any(String),
        difficulty: 'mythic',
        region: request.region,
      });
    }
    expect(result).toMatchObject({ boards: 15, bossBoards: 10, failed: 0 });

    // Every boss of every raid has every board, the closed raids' included.
    const stamped = await db.collection(BOSSES_COLLECTION).find({}).toArray();
    for (const entry of stamped) {
      expect(Object.keys(entry.bossRankingsUpdatedAt).sort(), entry.slug).toEqual(
        [...REGIONS].sort(),
      );
    }
  });

  it('stores each guild by id, with its rank, item level and first kill', async () => {
    expect(await board('gatekeeper', 'world')).toEqual([
      {
        guildId: 1047044,
        rank: 1,
        itemLevelAvg: 300 + (1047044 % 40) + 0.375,
        attempts: 9,
        // The first kill, not the later one the board lists after it.
        firstDefeated: new Date('2026-08-25T08:39:08Z'),
      },
      expect.objectContaining({ guildId: 43113, rank: 2, attempts: 12 }),
      expect.objectContaining({ guildId: 3001, rank: 3 }),
      expect.objectContaining({ guildId: 889329, rank: 4, attempts: 41 }),
      expect.objectContaining({ guildId: 2001, rank: 5 }),
    ]);
  });

  it('keeps a guild still progressing on the boss, with no kill to report', async () => {
    const queen = (await board('the-abyssal-queen', 'eu'))!;

    expect(queen).toEqual([
      expect.objectContaining({ guildId: 1047044, rank: 1, attempts: 335 }),
      {
        guildId: 889329,
        rank: 2,
        itemLevelAvg: 300 + (889329 % 40) + 0.375,
        attempts: null,
        firstDefeated: null,
      },
    ]);
  });

  it('stores a board nobody is on as empty and read', async () => {
    const first = await boss('first-boss');

    expect(first.bossRankings).toEqual(
      Object.fromEntries(REGIONS.map((region) => [region, { mythic: [] }])),
    );
    expect(await board('gatekeeper', 'tw')).toEqual([]);
  });

  it("reads an open raid's bosses every run, and leaves a finished raid's settled", async () => {
    const before = (await boss('dimensius')).bossRankingsUpdatedAt.eu.mythic as Date;

    const result = await rankings.refreshDue();

    expect(new Set(asked().map((entry) => entry.split('/')[0]))).toEqual(
      new Set(['the-venomous-abyss']),
    );
    expect(result).toMatchObject({ bossBoards: 10, settled: 25 });
    expect((await boss('dimensius')).bossRankingsUpdatedAt.eu.mythic).toEqual(before);
  });

  it('reads every boss of a finished raid again when asked for it by hand', async () => {
    await rankings.refreshRaid('manaforge-omega');

    expect(asked()).toEqual([
      ...REGIONS.map((region) => `manaforge-omega/plexus-sentinel/${region}`),
      ...REGIONS.map((region) => `manaforge-omega/dimensius/${region}`),
    ]);
  });

  it('records a refused boss board on the boss, keeps what it had, and does not ask hourly', async () => {
    const before = await board('gatekeeper', 'us');
    app.raiderIo.failWith('raiding/boss-rankings&boss:gatekeeper&region:us', { status: 400 });

    const result = await rankings.refreshDue();

    expect(result).toMatchObject({ refused: 1, stopped: null });
    const gatekeeper = await boss('gatekeeper');
    expect(gatekeeper.bossRankingsRefusedAt.us.mythic).toBeInstanceOf(Date);
    expect(gatekeeper.bossRankings.us.mythic).toEqual(before);
    expect(
      logger.of(
        'warn',
        /Raider\.io refused the us mythic ranking of gatekeeper in the-venomous-abyss/,
      ),
    ).toHaveLength(1);

    app.raiderIo.reset();
    await rankings.refreshDue();
    expect(asked(), 'refused an hour ago: not asked again yet').not.toContain(
      'the-venomous-abyss/gatekeeper/us',
    );

    // Read by hand, it is asked for, and no longer refused.
    await rankings.refreshRaid('the-venomous-abyss');
    expect((await boss('gatekeeper')).bossRankingsRefusedAt.us).toEqual({});
  });

  it('describes a guild that only a boss board names, before the board names it', async () => {
    app.raiderIo.corrupt(
      'raiding/boss-rankings&boss:the-abyssal-queen&region:tw',
      {
        bossRankings: [
          {
            rank: 1,
            guild: {
              id: 999_001,
              name: 'Boss Board Only',
              faction: 'alliance',
              region: { slug: 'tw' },
              realm: { slug: 'skywall', name: 'Skywall' },
            },
            itemLevelAvg: 321.5,
            encountersDefeated: [
              { slug: 'the-abyssal-queen', firstDefeated: '2026-09-30T12:00:00Z', attempts: 77 },
            ],
          },
        ],
      },
      1,
    );

    await rankings.refreshDue();

    expect(await board('the-abyssal-queen', 'tw')).toEqual([
      {
        guildId: 999_001,
        rank: 1,
        itemLevelAvg: 321.5,
        attempts: 77,
        firstDefeated: new Date('2026-09-30T12:00:00Z'),
      },
    ]);
    expect(
      await db
        .collection('guilds')
        .findOne({ id: 999_001 }, { projection: { _id: 0, name: 1, region: 1 } }),
      'on no raid board, and still a guild document',
    ).toEqual({ name: 'Boss Board Only', region: 'tw' });
  });

  it('skips a rank upstream serves as null, and stores the rest of the board', async () => {
    app.raiderIo.corrupt(
      'raiding/boss-rankings&boss:gatekeeper&region:eu',
      {
        bossRankings: [
          { rank: 1, guild: { id: 1047044, name: 'Echo' }, itemLevelAvg: 330 },
          null,
          { rank: 3, guild: { id: 889329, name: 'Mental Exiles' }, itemLevelAvg: 325 },
        ],
      },
      1,
    );

    const result = await rankings.refreshDue();

    expect(result).toMatchObject({ failed: 0, stopped: null });
    expect((await board('gatekeeper', 'eu'))!.map((entry) => entry.rank)).toEqual([1, 3]);
  });

  it("survives a catalogue refresh, which writes around the bosses' boards", async () => {
    const before = await boss('the-abyssal-queen');
    world.raids.find((entry) => entry.slug === 'the-venomous-abyss')!.encounters[1].name =
      'The Abyssal Queen, Renamed';

    await app.app.get(RaidCatalogueService).refresh();

    const after = await boss('the-abyssal-queen');
    expect(after.name).toBe('The Abyssal Queen, Renamed');
    expect(after.bossRankings).toEqual(before.bossRankings);
    expect(after.bossRankingsUpdatedAt).toEqual(before.bossRankingsUpdatedAt);
  });

  it('is charged to the rankings, reported with them, and holds every invariant', async () => {
    const budget = app.app.get(RaiderIoBudget);
    const before = budget.spent('raidRankings');

    const response = await fetch(new URL('/admin/raid-rankings?raid=manaforge-omega', app.url()), {
      method: 'POST',
    });
    expect(response.status).toBe(201);

    expect(bossRequests()).toHaveLength(10);
    expect(budget.spent('raidRankings') - before).toBe(app.raiderIo.requests.length);

    const health = await getJson<{ jobs: { raidRankings: { bossBoards: number } } }>(
      app.url(),
      '/health',
    );
    expect(health.body.jobs.raidRankings.bossBoards).toBe(10);

    await expectInvariants(db, undefined, world);
  });
});
