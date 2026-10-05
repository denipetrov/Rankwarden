import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { GUILDS_COLLECTION } from '../src/raid/entities/guild.entity.js';
import { RAIDS_COLLECTION } from '../src/raid/entities/raid.entity.js';
import { RaidCatalogueRepository } from '../src/raid/raid-catalogue.repository.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld, type WorldGuild } from './support/mplus-world.js';
import { World } from './support/world.js';

const REGIONS = ['world', 'us', 'eu', 'kr', 'tw'];
const DIFFICULTIES = ['mythic', 'heroic', 'normal'];

/** A raid's fifteen boards, in the order a run starts them, as `started()` names them. */
const boardsOf = (raid: string) =>
  DIFFICULTIES.flatMap((difficulty) =>
    REGIONS.map((region) => `${raid}/${difficulty}/${region}/0`),
  );

interface StoredEntry {
  rank: number;
  regionRank: number | null;
  guildId: number;
  encountersPulled: Record<string, unknown>[];
  encountersDefeated: Record<string, unknown>[];
}

/**
 * `count` guilds of one region, each with the raid's first boss down — a minute
 * apart from `firstMinute`, so their order on the board is the order here.
 */
function guildsOn(
  raid: string,
  boss: string,
  region: string,
  count: number,
  firstId: number,
  firstMinute = 0,
) {
  const minute = (index: number) =>
    new Date(Date.parse('2026-03-20T00:00:00Z') + (firstMinute + index) * 60_000).toISOString();

  return Array.from({ length: count }, (_, index): WorldGuild => ({
    id: firstId + index,
    name: `Guild ${firstId + index}`,
    faction: index % 2 === 0 ? 'horde' : 'alliance',
    region,
    realmSlug: 'stormrage',
    realmName: 'Stormrage',
    progress: { [raid]: [{ slug: boss, pulls: 10 + index, defeatedAt: minute(index) }] },
  }));
}

/**
 * The raid boards: for every raid in the catalogue, the top hundred guilds at
 * each difficulty on `world` and on each region, stored on the raid document,
 * with the guilds they name described once each in `guilds`.
 *
 * The world's catalogue is three raids: The Venomous Abyss, still open, with
 * five guilds on its Mythic boards and a few on Heroic and Normal; Manaforge
 * Omega, finished, with two; and Tier MN 1, finished, with nobody.
 */
describe('Raid rankings', () => {
  let app: TestApp;
  let db: Db;
  let rankings: RaidRankingsService;
  /** Ranking requests made by the time the app had booted, before any sweep. */
  let bootRequests = -1;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  // Heroic and Normal are boards of their own: a different order, and a guild
  // that is on no Mythic board at all.
  const echo = world.guilds.find((entry) => entry.id === 1047044)!;
  echo.heroic = {
    'the-venomous-abyss': [
      { slug: 'gatekeeper', pulls: 1, defeatedAt: '2026-08-19T05:00:00Z' },
      { slug: 'the-abyssal-queen', pulls: 4, defeatedAt: '2026-08-19T09:00:00Z' },
    ],
  };
  world.guilds.find((entry) => entry.id === 889329)!.normal = {
    'the-venomous-abyss': [{ slug: 'gatekeeper', pulls: 2, defeatedAt: '2026-08-19T06:00:00Z' }],
  };
  world.guilds.push({
    id: 4001,
    name: 'Heroic Only',
    faction: 'alliance',
    region: 'eu',
    realmSlug: 'silvermoon',
    realmName: 'Silvermoon',
    progress: {},
    heroic: {
      'the-venomous-abyss': [
        { slug: 'gatekeeper', pulls: 3, defeatedAt: '2026-08-19T04:00:00Z' },
        { slug: 'the-abyssal-queen', pulls: 9, defeatedAt: '2026-08-19T08:00:00Z' },
      ],
    },
  });

  const requests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/raid-rankings');
  const asked = () =>
    requests().map(
      (request) =>
        `${request.params.raid}/${request.params.difficulty}/${request.region}/${request.page}`,
    );
  /**
   * The first page of each board, which is the order boards were started in. A
   * board with guilds on it is asked for a second page too: only an empty page
   * ends a board.
   */
  const started = () => asked().filter((entry) => entry.endsWith('/0'));
  const raid = async (slug: string) => (await db.collection(RAIDS_COLLECTION).findOne({ slug }))!;
  const board = async (slug: string, region: string, difficulty = 'mythic') =>
    ((await raid(slug)).guilds?.[region]?.[difficulty] ?? null) as StoredEntry[] | null;
  const guild = (id: number) =>
    db.collection(GUILDS_COLLECTION).findOne({ id }, { projection: { _id: 0 } });

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAID_CATALOGUE_ENABLED: 'true', RAID_RANKINGS_ENABLED: 'true' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    bootRequests = requests().length;
    // The rankings wait for the first sweep; with enrichment and Mythic+ off,
    // it is the one event that lets them start.
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

  it('reads nothing at boot, then every board of every raid once live ingestion has warmed up', async () => {
    expect(bootRequests, 'boot is for the jobs that matter more').toBe(0);
    // The open raid first, and Mythic first within a raid.
    expect(started()).toEqual([
      ...boardsOf('the-venomous-abyss'),
      ...boardsOf('tier-mn-1'),
      ...boardsOf('manaforge-omega'),
    ]);
    // Twenty at a time: what keeps one request under upstream's timeout.
    for (const request of requests()) expect(request.params).toMatchObject({ limit: 20 });
    expect(logger.of('warn', /rank/i)).toEqual([]);
    expect(
      logger.matching(/Raid rankings: 45 board\(s\) read across 3 raid\(s\), 6 guild write\(s\)/),
    ).toHaveLength(1);
  });

  it('stores a board on its raid: guilds by id, best first, bosses tied to the raid', async () => {
    const eu = (await board('the-venomous-abyss', 'eu'))!;

    expect(eu).toEqual([
      {
        rank: 1,
        regionRank: 1,
        guildId: 1047044,
        encountersPulled: [
          {
            encounterId: 210001,
            slug: 'gatekeeper',
            numPulls: 9,
            pullStartedAt: new Date('2026-08-24T12:23:39Z'),
            bestPercent: 0,
            isDefeated: true,
          },
          {
            encounterId: 210008,
            slug: 'the-abyssal-queen',
            numPulls: 335,
            pullStartedAt: new Date('2026-08-24T12:23:39Z'),
            bestPercent: 0,
            isDefeated: true,
          },
        ],
        encountersDefeated: [
          {
            encounterId: 210001,
            slug: 'gatekeeper',
            firstDefeated: new Date('2026-08-25T08:39:08Z'),
            lastDefeated: new Date('2026-08-25T08:39:08Z'),
          },
          {
            encounterId: 210008,
            slug: 'the-abyssal-queen',
            firstDefeated: new Date('2026-09-03T19:29:00Z'),
            lastDefeated: new Date('2026-09-03T19:29:00Z'),
          },
        ],
      },
      {
        rank: 2,
        regionRank: 2,
        guildId: 889329,
        encountersPulled: [
          expect.objectContaining({ encounterId: 210001, numPulls: 41, isDefeated: true }),
          // Still progressing: the pulls so far and the best attempt.
          {
            encounterId: 210008,
            slug: 'the-abyssal-queen',
            numPulls: 118,
            pullStartedAt: new Date('2026-08-24T12:23:39Z'),
            bestPercent: 23.4,
            isDefeated: false,
          },
        ],
        encountersDefeated: [expect.objectContaining({ encounterId: 210001, slug: 'gatekeeper' })],
      },
    ]);

    // The boss's name is read from the same document, by the id the entry carries.
    const stored = await raid('the-venomous-abyss');
    const boss = stored.encounters.find((encounter: { id: number }) => encounter.id === 210008);
    expect(boss.name).toBe('The Abyssal Queen');
    expect(stored.guildsUpdatedAt.eu.mythic).toBeInstanceOf(Date);
  });

  it('ranks the world board across regions, each guild with its place in its own', async () => {
    const worldBoard = (await board('the-venomous-abyss', 'world'))!;

    expect(
      worldBoard.map((entry) => [entry.rank, entry.regionRank, entry.guildId]),
      'world rank, then the rank within the guild own region',
    ).toEqual([
      [1, 1, 1047044],
      [2, 1, 43113],
      [3, 1, 3001],
      [4, 2, 889329],
      [5, 2, 2001],
    ]);
    expect((await board('the-venomous-abyss', 'us'))!.map((entry) => entry.guildId)).toEqual([
      43113, 2001,
    ]);
  });

  it('keeps each difficulty as a board of its own, beside the others', async () => {
    const heroic = (await board('the-venomous-abyss', 'eu', 'heroic'))!;
    const normal = (await board('the-venomous-abyss', 'eu', 'normal'))!;

    // Heroic Only cleared it an hour before Echo did, and is on no Mythic board.
    expect(heroic.map((entry) => [entry.rank, entry.guildId])).toEqual([
      [1, 4001],
      [2, 1047044],
    ]);
    expect(heroic[1].encountersPulled[1]).toMatchObject({ encounterId: 210008, numPulls: 4 });
    expect(normal.map((entry) => entry.guildId)).toEqual([889329]);
    expect((await board('the-venomous-abyss', 'eu'))!.map((entry) => entry.guildId)).toEqual([
      1047044, 889329,
    ]);

    expect(await guild(4001), 'a guild on a Heroic board only is still described').toMatchObject({
      name: 'Heroic Only',
      region: 'eu',
    });
    const stored = await raid('the-venomous-abyss');
    expect(Object.keys(stored.guilds.eu).sort()).toEqual(['heroic', 'mythic', 'normal']);
    expect(Object.keys(stored.guildsUpdatedAt.eu).sort()).toEqual(['heroic', 'mythic', 'normal']);
  });

  it('describes each guild once in `guilds`, whatever boards name it', async () => {
    expect(await db.collection(GUILDS_COLLECTION).countDocuments()).toBe(6);
    expect(await guild(1047044)).toEqual({
      id: 1047044,
      name: 'Echo',
      faction: 'horde',
      logo: 'https://cdn.example/echo.png',
      region: 'eu',
      realm: { slug: 'tarren-mill', name: 'Tarren Mill' },
      updatedAt: expect.any(Date),
    });
    // No logo of its own: the default one upstream serves in its place.
    expect((await guild(889329))!.logo).toBe(
      'https://cdn.raiderio.net/images/site/alliance_icon4.png',
    );
    // No `cn` board is read, and the world board still brings its guilds in.
    expect(await guild(3001)).toMatchObject({ name: '佶天鸿', region: 'cn' });

    const indexes = Object.fromEntries(
      (await db.collection(GUILDS_COLLECTION).indexes())
        .filter((index) => index.name !== '_id_')
        .map((index) => [index.name, { key: index.key, unique: index.unique === true }]),
    );
    expect(indexes).toEqual({
      guild_identity: { key: { id: 1 }, unique: true },
      guild_region_realm_name: { key: { region: 1, 'realm.slug': 1, name: 1 }, unique: false },
    });
    await expect(
      db.collection(GUILDS_COLLECTION).insertOne({ id: 1047044, name: 'Echo again' }),
    ).rejects.toThrow(/duplicate key/);
  });

  it('keeps a guild that hides its pulls, with the kills and without the counts', async () => {
    const quiet = (await board('the-venomous-abyss', 'us'))![1];

    expect(quiet.guildId).toBe(2001);
    expect(quiet.encountersPulled).toEqual([
      {
        encounterId: 210001,
        slug: 'gatekeeper',
        numPulls: null,
        pullStartedAt: null,
        bestPercent: 0,
        isDefeated: true,
      },
    ]);
    expect(quiet.encountersDefeated).toHaveLength(1);
  });

  it('stores a board nobody is on as empty and read, not as missing', async () => {
    expect(await board('the-venomous-abyss', 'kr')).toEqual([]);

    const empty = await raid('tier-mn-1');
    const nobody = { mythic: [], heroic: [], normal: [] };
    expect(empty.guilds).toEqual({
      world: nobody,
      us: nobody,
      eu: nobody,
      kr: nobody,
      tw: nobody,
    });
    for (const region of REGIONS) {
      expect(Object.keys(empty.guildsUpdatedAt[region]).sort()).toEqual([...DIFFICULTIES].sort());
    }
  });

  it('reads an open raid again every run, and leaves a finished raid settled', async () => {
    const before = (await raid('manaforge-omega')).guildsUpdatedAt.eu.mythic as Date;

    const result = await rankings.refreshDue();

    expect(started()).toEqual(boardsOf('the-venomous-abyss'));
    expect(result).toMatchObject({ boards: 15, settled: 30, raids: 1, failed: 0, stopped: null });
    expect((await raid('manaforge-omega')).guildsUpdatedAt.eu.mythic).toEqual(before);
  });

  it('reads a finished raid once more when its last read was before it closed', async () => {
    // Manaforge Omega closed 2026-03-02; this board was last read while it was open.
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne(
        { slug: 'manaforge-omega' },
        { $set: { 'guildsUpdatedAt.eu.heroic': new Date('2026-01-01T00:00:00Z') } },
      );

    await rankings.refreshDue();
    expect(started().filter((entry) => entry.startsWith('manaforge-omega'))).toEqual([
      'manaforge-omega/heroic/eu/0',
    ]);

    app.raiderIo.reset();
    await rankings.refreshDue();
    expect(asked().filter((entry) => entry.startsWith('manaforge-omega'))).toEqual([]);
  });

  it('replaces a board and updates a guild in place as the race moves', async () => {
    const exiles = world.guilds.find((entry) => entry.id === 889329)!;
    exiles.progress['the-venomous-abyss'][1] = {
      slug: 'the-abyssal-queen',
      pulls: 140,
      defeatedAt: '2026-09-04T01:00:00Z',
    };
    exiles.name = 'Mental Exiles Reborn';
    exiles.logo = 'https://cdn.example/exiles.png';

    await rankings.refreshDue();

    // Killed an hour before Liquid did, so second in the world.
    expect((await board('the-venomous-abyss', 'world'))!.map((entry) => entry.guildId)).toEqual([
      1047044, 889329, 43113, 3001, 2001,
    ]);
    const second = (await board('the-venomous-abyss', 'eu'))![1];
    expect(second.encountersPulled[1]).toMatchObject({ numPulls: 140, isDefeated: true });
    expect(second.encountersDefeated).toHaveLength(2);

    expect(await guild(889329)).toMatchObject({
      name: 'Mental Exiles Reborn',
      logo: 'https://cdn.example/exiles.png',
    });
    expect(await db.collection(GUILDS_COLLECTION).countDocuments(), 'updated, not added').toBe(6);
  });

  it('reads a long board in pages, stops at the empty one, and keeps the top hundred', async () => {
    world.guilds.push(...guildsOn('tier-mn-1', 'first-boss', 'us', 45, 50_000));

    const first = await rankings.refreshRaid('tier-mn-1');

    expect(first).toMatchObject({ boards: 15, failed: 0 });
    // 45 guilds: two full pages, a short third, and the empty fourth that ends
    // the board; an empty board is one page.
    expect(asked().filter((entry) => entry.startsWith('tier-mn-1/mythic/us/'))).toEqual([
      'tier-mn-1/mythic/us/0',
      'tier-mn-1/mythic/us/1',
      'tier-mn-1/mythic/us/2',
      'tier-mn-1/mythic/us/3',
    ]);
    expect(asked().filter((entry) => entry.startsWith('tier-mn-1/mythic/eu/'))).toEqual([
      'tier-mn-1/mythic/eu/0',
    ]);
    const us = (await board('tier-mn-1', 'us'))!;
    expect(us.map((entry) => entry.rank)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(us[44].guildId).toBe(50_044);

    // 115 guilds: five full pages, and no sixth.
    world.guilds.push(...guildsOn('tier-mn-1', 'first-boss', 'us', 70, 60_000, 45));
    app.raiderIo.reset();
    await rankings.refreshRaid('tier-mn-1');

    expect(asked().filter((entry) => entry.startsWith('tier-mn-1/mythic/us/'))).toHaveLength(5);
    expect(await board('tier-mn-1', 'us')).toHaveLength(100);
    expect(await board('tier-mn-1', 'world')).toHaveLength(100);
    // Only guilds a stored board names are written: 6, and the hundred here.
    expect(await db.collection(GUILDS_COLLECTION).countDocuments()).toBe(106);
  });

  it('keeps the whole old board when any page of the new one fails', async () => {
    const before = await raid('tier-mn-1');
    // The board would change: the leader is gone from it.
    world.guilds = world.guilds.filter((entry) => entry.id !== 50_000);
    app.raiderIo.failWith(
      'raiding/raid-rankings&raid:tier-mn-1&difficulty:mythic&region:us&page:3',
      { status: 503, times: 1 },
    );

    const result = await rankings.refreshRaid('tier-mn-1');

    expect(result).toMatchObject({ boards: 14, failed: 1, stopped: null });
    const after = await raid('tier-mn-1');
    expect(after.guilds.us.mythic, 'not the first three pages of the new board').toEqual(
      before.guilds.us.mythic,
    );
    expect(after.guildsUpdatedAt.us.mythic).toEqual(before.guildsUpdatedAt.us.mythic);
    expect(after.guilds.world.mythic[0].guildId, 'the boards that could be read were').toBe(50_001);
    expect(
      logger.of(
        'warn',
        /Could not read the us mythic ranking of tier-mn-1: .*keeping what is stored/,
      ),
    ).toHaveLength(1);

    // Still owed, and read on the next attempt.
    await rankings.refreshRaid('tier-mn-1');
    expect((await board('tier-mn-1', 'us'))![0].guildId).toBe(50_001);
  });

  it('gives up for this run after three boards in a row fail', async () => {
    app.raiderIo.failWith('raiding/raid-rankings', { status: 503 });
    const before = await raid('the-venomous-abyss');

    const result = await rankings.refreshDue();

    expect(result).toMatchObject({
      boards: 0,
      failed: 3,
      stopped: '3 boards in a row could not be read',
    });
    expect(requests(), 'not one request per board of every raid').toHaveLength(3);
    expect((await raid('the-venomous-abyss')).guilds).toEqual(before.guilds);
    expect(logger.matching(/stopped early: 3 boards in a row/)).toHaveLength(1);
  });

  it('does not take a refused board for an outage, and carries on past it', async () => {
    app.raiderIo.failWith('raiding/raid-rankings&raid:the-venomous-abyss', { status: 400 });

    const result = await rankings.refreshDue();

    expect(result).toMatchObject({ boards: 0, failed: 15, refused: 15, stopped: null });
    expect(
      logger.of('warn', /Raider\.io refused the \w+ \w+ ranking of the-venomous-abyss/),
    ).toHaveLength(15);

    // A refusal is an answer: the boards it had are kept, and it is not asked
    // for again an hour later, open raid or not.
    const refused = await raid('the-venomous-abyss');
    expect(Object.keys(refused.guildsRefusedAt.eu).sort()).toEqual(['heroic', 'mythic', 'normal']);
    expect(refused.guilds.eu.mythic).toHaveLength(2);
    app.raiderIo.reset();
    expect(await rankings.refreshDue()).toMatchObject({ boards: 0, failed: 0, settled: 45 });
    expect(requests()).toEqual([]);

    // Read by hand, it is asked for again, and a board read is no longer refused.
    expect(await rankings.refreshRaid('the-venomous-abyss')).toMatchObject({ boards: 15 });
    expect((await raid('the-venomous-abyss')).guildsRefusedAt).toEqual({
      world: {},
      us: {},
      eu: {},
      kr: {},
      tw: {},
    });
  });

  it('keeps the old board when the payload does not parse', async () => {
    const before = (await raid('the-venomous-abyss')).guilds.eu.mythic;
    app.raiderIo.corrupt(
      'raiding/raid-rankings&region:eu&difficulty:mythic',
      { raidRankings: [{ rank: 1, guild: { name: 'No id' } }] },
      1,
    );

    const result = await rankings.refreshDue();

    expect(result).toMatchObject({ boards: 14, failed: 1 });
    expect((await raid('the-venomous-abyss')).guilds.eu.mythic).toEqual(before);
    expect(logger.of('warn', /schema issues: raidRankings/)).toHaveLength(1);
  });

  it('stores a boss the catalogue does not list untied, and says so', async () => {
    world.guilds
      .find((entry) => entry.id === 2001)!
      .progress['the-venomous-abyss'].push({ slug: 'secret-boss', pulls: 4, bestPercent: 80 });

    await rankings.refreshDue();

    const quiet = (await board('the-venomous-abyss', 'us'))!.find(
      (entry) => entry.guildId === 2001,
    )!;
    expect(quiet.encountersPulled[1]).toMatchObject({ encounterId: null, slug: 'secret-boss' });
    expect(
      logger.of('warn', /us mythic ranking of the-venomous-abyss names boss\(es\).*secret-boss/),
    ).toHaveLength(1);

    world.guilds.find((entry) => entry.id === 2001)!.progress['the-venomous-abyss'].pop();
    await rankings.refreshDue();
  });

  it('serves a raid older than its pull data with the kills alone', async () => {
    world.raidsWithoutPulls.add('manaforge-omega');

    await rankings.refreshRaid('manaforge-omega');

    const [first] = (await board('manaforge-omega', 'eu'))!;
    expect(first.encountersPulled).toEqual([]);
    expect(first.encountersDefeated.map((kill) => kill.encounterId)).toEqual([197124, 197131]);
  });

  it('survives a catalogue refresh, and stops reading a raid no longer listed', async () => {
    const before = (await raid('the-venomous-abyss')).guilds;
    world.raids = world.raids.filter((entry) => entry.slug !== 'tier-mn-1');

    await app.app.get(RaidCatalogueService).refresh();

    expect(
      (await raid('the-venomous-abyss')).guilds,
      'the catalogue writes around the boards',
    ).toEqual(before);
    const unlisted = await raid('tier-mn-1');
    expect(unlisted.unlistedAt).toBeInstanceOf(Date);
    expect(unlisted.guilds.us.mythic, 'kept as it was last read').toHaveLength(100);

    expect(await rankings.refreshRaid('tier-mn-1'), 'not a raid to read any more').toBeNull();
    // Even with a board it never read, which a listed raid would be owed.
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne(
        { slug: 'tier-mn-1' },
        { $unset: { 'guilds.kr.normal': '', 'guildsUpdatedAt.kr.normal': '' } },
      );
    await rankings.refreshDue();
    expect(asked().some((entry) => entry.startsWith('tier-mn-1'))).toBe(false);
  });

  it('keeps the boards out of what the catalogue reads', async () => {
    const repository = app.app.get(RaidCatalogueRepository);

    const one = await repository.findBySlug('the-venomous-abyss');
    expect(one).toMatchObject({ slug: 'the-venomous-abyss', guildsUpdatedAt: expect.any(Object) });
    expect(one).not.toHaveProperty('guilds');
    for (const entry of await repository.allRaids()) expect(entry).not.toHaveProperty('guilds');
  });

  it('POST /admin/raid-rankings runs what is due; ?raid= re-reads one raid whole', async () => {
    const budget = app.app.get(RaiderIoBudget);
    const before = { other: budget.spent('other'), mplus: budget.spent('mplus') };

    const due = await postJson<{ boards: number; settled: number }>(
      app.url(),
      '/admin/raid-rankings',
    );
    expect(due.status).toBe(201);
    expect(due.body).toMatchObject({ boards: 15, settled: 15, failed: 0 });

    const one = await postJson<{ boards: number }>(
      app.url(),
      '/admin/raid-rankings?raid=manaforge-omega',
    );
    expect(one.status).toBe(201);
    expect(one.body).toMatchObject({ boards: 15, raids: 1 });
    expect(started().slice(15)).toEqual(boardsOf('manaforge-omega'));

    // Thirty boards, and a second page for each of the ten with guilds on it.
    expect(budget.spent('other') - before.other, 'charged to the general allowance').toBe(
      requests().length,
    );
    expect(requests().length).toBeGreaterThan(30);
    expect(budget.spent('mplus')).toBe(before.mplus);

    const unknown = await postJson(app.url(), '/admin/raid-rankings?raid=no-such-raid');
    expect(unknown.status).toBe(404);

    await expectInvariants(db);
  });
});
