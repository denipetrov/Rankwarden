import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { RaidRankingsRepository } from '../src/raid/raid-rankings.repository.js';
import { RaidRankingsScheduler } from '../src/raid/raid-rankings.scheduler.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { getJson, postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld, type WorldGuild } from './support/mplus-world.js';
import { World } from './support/world.js';
import { GUILDS_COLLECTION, RAIDS_COLLECTION } from '../src/database/collections.js';

const REGIONS = ['world', 'us', 'eu', 'kr', 'tw'];
/** A finished raid nobody is ranked on, so each case can put its own guilds there. */
const RAID = 'tier-mn-1';
const BOSS = 'first-boss';

interface StoredEntry {
  rank: number;
  regionRank: number | null;
  guildId: number;
}

/**
 * `count` guilds on `RAID`, a minute apart in kill time from `firstMinute`, so
 * their order on the board is the order here.
 */
function guildsOn(
  count: number,
  firstId: number,
  options: { region?: (index: number) => string; firstMinute?: number } = {},
): WorldGuild[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    name: `Guild ${firstId + index}`,
    faction: index % 2 === 0 ? ('horde' as const) : ('alliance' as const),
    region: options.region?.(index) ?? 'us',
    realmSlug: 'stormrage',
    realmName: 'Stormrage',
    progress: {
      [RAID]: [
        {
          slug: BOSS,
          pulls: 10 + index,
          defeatedAt: new Date(
            Date.parse('2026-03-20T00:00:00Z') + ((options.firstMinute ?? 0) + index) * 60_000,
          ).toISOString(),
        },
      ],
    },
  }));
}

/**
 * Raid plan R2-R7 — reading a board, what is due, the guilds, failures and
 * what an operator is told.
 *
 * Mythic only, one board at a time and no wait for idle (the harness defaults),
 * so request order and "the wait ran out" can both be asserted. A sweep opens
 * the scheduler's gates in `beforeAll`, which reads every board once.
 */
describe('Raid plan R2-R7 — boards, guilds and failures', () => {
  let app: TestApp;
  let db: Db;
  let rankings: RaidRankingsService;
  const logger = new CapturingLogger();
  const world = new MplusWorld();
  /** The guilds the world starts with: on the open raid and Manaforge Omega. */
  const base = [...world.guilds];

  const requests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/raid-rankings');
  const asked = (slug = RAID) =>
    requests()
      .filter((request) => request.params.raid === slug)
      .map((request) => `${request.region}/${request.page}`);
  const started = () =>
    requests()
      .filter((request) => request.page === 0)
      .map((request) => `${request.params.raid}/${request.region}`);
  const raid = async (slug = RAID) => (await db.collection(RAIDS_COLLECTION).findOne({ slug }))!;
  const board = async (region: string, slug = RAID) =>
    ((await raid(slug)).guilds?.[region]?.mythic ?? null) as StoredEntry[] | null;
  const guild = (id: number) =>
    db.collection(GUILDS_COLLECTION).findOne({ id }, { projection: { _id: 0 } });
  /** Puts exactly these guilds on `RAID`, beside the world's own. */
  const rank = (...guilds: WorldGuild[]) => {
    world.guilds = [...base, ...guilds];
  };
  /** Forgets one board of `RAID`, as if it had never been read. */
  const forget = (region: string, slug = RAID) =>
    db.collection(RAIDS_COLLECTION).updateOne(
      { slug },
      {
        $unset: {
          [`guilds.${region}.mythic`]: '',
          [`guildsUpdatedAt.${region}.mythic`]: '',
          [`guildsRefusedAt.${region}.mythic`]: '',
        },
      },
    );
  /** Fires the scheduler's tick by hand: the interval itself is an hour long. */
  const tick = () =>
    (app.app.get(RaidRankingsScheduler) as unknown as { tick(): Promise<void> }).tick();

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAID_CATALOGUE_ENABLED: 'true',
        RAID_RANKINGS_ENABLED: 'true',
        RAID_RANKINGS_DIFFICULTIES: 'mythic',
      },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
    await app.listen();
    app.raiderIo.reset();
    logger.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await releaseAllHolds();
    await app.settle();
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('R2 reading a board', () => {
    it('R2.2 a whole window of ranks not served ends the board there', async () => {
      const guilds = guildsOn(100, 10_000);
      for (const hidden of guilds.slice(20, 40)) hidden.notServed = true;
      rank(...guilds);

      await rankings.refreshRaid(RAID);

      // Pinned, not endorsed: an empty page is how a board that is over
      // answers, so ranks 41-100 behind twenty hidden ones in a row are lost.
      expect(asked().filter((entry) => entry.startsWith('us/'))).toEqual(['us/0', 'us/1']);
      expect(await board('us')).toHaveLength(20);
    });

    it('R2.3 a board that truly ends on a short page costs one request past it', async () => {
      rank(...guildsOn(42, 11_000));

      await rankings.refreshRaid(RAID);

      expect(asked().filter((entry) => entry.startsWith('us/'))).toEqual([
        'us/0',
        'us/1',
        'us/2',
        'us/3',
      ]);
      expect((await board('us'))!.map((entry) => entry.rank)).toEqual(
        Array.from({ length: 42 }, (_, index) => index + 1),
      );
      await expectInvariants(db, undefined, world);
    });

    it.each([
      [99, 99],
      [100, 100],
      [101, 100],
    ])('R2.4 %i guilds ranked: %i stored, and never a sixth page', async (ranked, stored) => {
      rank(...guildsOn(ranked, 12_000));

      await rankings.refreshRaid(RAID);

      expect(asked().filter((entry) => entry.startsWith('us/'))).toEqual([
        'us/0',
        'us/1',
        'us/2',
        'us/3',
        'us/4',
      ]);
      const us = (await board('us'))!;
      expect(us).toHaveLength(stored);
      expect(us.at(-1)!.rank).toBe(stored);
      await expectInvariants(db, undefined, world);
    });

    it('R2.5 a board that moves between two pages stores no guild and no rank twice', async () => {
      const guilds = guildsOn(40, 13_000);
      rank(...guilds);
      // Between page 0 and page 1 of the us board, the guild at 21 overtakes
      // the one at 20: the one now at 21 was already read at 20.
      app.raiderIo.beforeServe = (request) => {
        if (request.path !== 'raiding/raid-rankings') return;
        if (request.params.raid !== RAID || request.region !== 'us' || request.page !== 1) return;

        const climber = guilds[20].progress[RAID][0];
        climber.defeatedAt = new Date(
          Date.parse(guilds[19].progress[RAID][0].defeatedAt!) - 1,
        ).toISOString();
      };

      await rankings.refreshRaid(RAID);

      const us = (await board('us'))!;
      expect(us).toHaveLength(39);
      expect(new Set(us.map((entry) => entry.guildId)).size).toBe(39);
      expect(new Set(us.map((entry) => entry.rank)).size).toBe(39);
      expect(
        us.find((entry) => entry.guildId === 13_019)!.rank,
        'kept where it was first met',
      ).toBe(20);
      // I27, not I28: the board is well-formed, and one read behind the world.
      await expectInvariants(db);
    });

    it('R2.6 region ranks on the world board match each region own board, hidden guilds or not', async () => {
      const guilds = guildsOn(60, 14_000, { region: (index) => ['us', 'eu', 'kr'][index % 3] });
      for (const index of [4, 5, 27, 44]) guilds[index].notServed = true;
      rank(...guilds);

      await rankings.refreshRaid(RAID);

      const own = new Map<number, number>();
      for (const region of ['us', 'eu', 'kr']) {
        for (const entry of (await board(region))!) own.set(entry.guildId, entry.rank);
      }
      const worldBoard = (await board('world'))!;
      expect(worldBoard).toHaveLength(56);
      for (const entry of worldBoard) {
        expect(entry.regionRank, `guild ${entry.guildId}`).toBe(own.get(entry.guildId));
      }
      // A hidden guild still holds its rank: the ones behind it are not moved up.
      expect(worldBoard.map((entry) => entry.rank)).not.toContain(5);
      await expectInvariants(db, undefined, world);
    });
  });

  describe('R3 what is due', () => {
    it('R3.2 a raid with ends for only some regions is closed for every board', async () => {
      // The world lists `us` and `eu` ends for this raid and nothing for kr or tw.
      expect(Object.keys((await raid()).ends).sort()).toEqual(['eu', 'us']);
      rank();
      await forget('kr');

      await rankings.refreshDue();
      expect(asked(), 'never read, so owed').toEqual(['kr/0']);

      app.raiderIo.reset();
      await rankings.refreshDue();
      expect(asked(), 'and settled like the rest once read').toEqual([]);
    });

    it('R3.3 a board is stamped with when its run began, so a run across the close reads once more', async () => {
      rank(...guildsOn(3, 15_000));
      // A run that began nine days before the raid closed (2026-08-19).
      const beganAt = new Date('2026-08-10T00:00:00Z');

      await rankings.refreshDue(beganAt);
      expect((await raid()).guildsUpdatedAt.us.mythic, 'the run start, not the read').toEqual(
        beganAt,
      );

      // One extra read, never a missed one.
      app.raiderIo.reset();
      await rankings.refreshDue();
      expect(started().filter((entry) => entry.startsWith(RAID))).toEqual(
        REGIONS.map((region) => `${RAID}/${region}`),
      );

      app.raiderIo.reset();
      await rankings.refreshDue();
      expect(asked()).toEqual([]);
    });

    it('R3.4 a run after the backfill costs only the open raid', async () => {
      const result = await rankings.refreshDue();

      expect(started()).toEqual(REGIONS.map((region) => `the-venomous-abyss/${region}`));
      expect(result).toMatchObject({ boards: 5, settled: 10, raids: 1, failed: 0 });
      expect(
        logger.matching(
          /Raid rankings: 5 board\(s\) read across 1 raid\(s\), \d+ guild write\(s\)$/,
        ),
        'R7.8 one summary line a run',
      ).toHaveLength(1);
    });

    it('R3.5 a run that gave up leaves the rest due: the open raid first, then what was never read', async () => {
      await forget('us');
      await forget('eu', 'manaforge-omega');
      app.raiderIo.failWith('raiding/raid-rankings', { status: 503 });

      const gaveUp = await rankings.refreshDue();
      expect(gaveUp).toMatchObject({ boards: 0, failed: 3, stopped: expect.any(String) });
      expect(started()).toEqual([
        'the-venomous-abyss/world',
        'the-venomous-abyss/us',
        'the-venomous-abyss/eu',
      ]);

      app.raiderIo.reset();
      const next = await rankings.refreshDue();

      expect(started()).toEqual([
        ...REGIONS.map((region) => `the-venomous-abyss/${region}`),
        `${RAID}/us`,
        'manaforge-omega/eu',
      ]);
      expect(next).toMatchObject({ boards: 7, settled: 8, failed: 0, stopped: null });
    });
  });

  describe('R4 guilds', () => {
    it('R4.1 a later, sparser description does not blank what is known of a guild', async () => {
      rank(...guildsOn(2, 16_000));
      await rankings.refreshRaid(RAID);
      const before = (await guild(16_000))!;
      expect(before.realm).toEqual({ slug: 'stormrage', name: 'Stormrage' });

      // The last board read describes the guild by id and name alone.
      app.raiderIo.corrupt(
        `raiding/raid-rankings&raid:${RAID}&region:tw&page:0`,
        { raidRankings: [{ rank: 1, guild: { id: 16_000, name: 'Guild 16000 II' } }] },
        1,
      );
      await rankings.refreshRaid(RAID);

      expect(await guild(16_000)).toMatchObject({
        name: 'Guild 16000 II',
        faction: before.faction,
        region: 'us',
        realm: { slug: 'stormrage', name: 'Stormrage' },
        logo: before.logo,
      });
      // Read properly again: the board is put right, and the name with it.
      await rankings.refreshRaid(RAID);
      expect((await guild(16_000))!.name).toBe('Guild 16000');
    });

    it('R4.2 a rename and a realm transfer update the guild in place', async () => {
      const guilds = guildsOn(2, 17_000);
      rank(...guilds);
      await rankings.refreshRaid(RAID);
      const count = await db.collection(GUILDS_COLLECTION).countDocuments();

      Object.assign(guilds[0], {
        name: 'Renamed',
        realmSlug: 'area-52',
        realmName: 'Area 52',
        faction: 'alliance',
      });
      await rankings.refreshRaid(RAID);

      expect(await guild(17_000)).toMatchObject({
        name: 'Renamed',
        faction: 'alliance',
        realm: { slug: 'area-52', name: 'Area 52' },
      });
      expect(await db.collection(GUILDS_COLLECTION).countDocuments()).toBe(count);
      await expectInvariants(db, undefined, world);
    });

    it('R4.3 a guild that leaves every board is kept, and no longer touched', async () => {
      rank(...guildsOn(2, 18_000));
      await rankings.refreshRaid(RAID, new Date('2026-10-01T00:00:00Z'));
      const before = (await guild(18_001))!;

      rank(...guildsOn(1, 18_000));
      await rankings.refreshRaid(RAID, new Date('2026-10-02T00:00:00Z'));

      expect(await guild(18_001), 'what an older board may still point at').toEqual(before);
      expect((await guild(18_000))!.updatedAt).toEqual(new Date('2026-10-02T00:00:00Z'));
      const named = (await db.collection(RAIDS_COLLECTION).find({}).toArray()).some((entry) =>
        JSON.stringify(entry.guilds ?? {}).includes('"guildId":18001'),
      );
      expect(named, 'no board names it any more').toBe(false);
      await expectInvariants(db, undefined, world);
    });

    it('R4.4 a failure between the guild write and the board write leaves the board as it was', async () => {
      rank(...guildsOn(2, 19_000));
      await rankings.refreshRaid(RAID);
      const before = await raid();

      rank(...guildsOn(3, 19_000));
      const repository = app.app.get(RaidRankingsRepository);
      vi.spyOn(repository, 'setBoard').mockRejectedValueOnce(new Error('mongo is gone'));

      const result = await rankings.refreshRaid(RAID);

      expect(result).toMatchObject({ boards: 4, failed: 1 });
      // The world board was first: its guilds were written, its board was not.
      expect(await guild(19_002), 'written before the board that names it').not.toBeNull();
      const after = await raid();
      expect(after.guilds.world.mythic).toEqual(before.guilds.world.mythic);
      expect(after.guildsUpdatedAt.world.mythic).toEqual(before.guildsUpdatedAt.world.mythic);
      expect(after.guilds.us.mythic).toHaveLength(3);
      await expectInvariants(db);

      await rankings.refreshRaid(RAID);
      expect(await board('world')).toHaveLength(3);
    });

    it('R4.5 a run counts a guild once however many boards name it', async () => {
      rank(...guildsOn(7, 20_000));

      // Each guild is on the world board and on the us one.
      const first = await rankings.refreshRaid(RAID, new Date('2026-10-01T00:00:00Z'));
      expect(first).toMatchObject({ boards: 5, guilds: 7 });

      // Nothing changed but the day: the only writes are the seven stamps.
      const second = await rankings.refreshRaid(RAID, new Date('2026-10-02T00:00:00Z'));
      expect(second).toMatchObject({ boards: 5, guilds: 7 });

      // And nothing at all when the stamp does not move either.
      const third = await rankings.refreshRaid(RAID, new Date('2026-10-02T00:00:00Z'));
      expect(third).toMatchObject({ boards: 5, guilds: 0 });
    });

    it('R4.6 names outside ASCII are stored as served, and found by the lookup index', async () => {
      const names: [string, string, string, string][] = [
        ['cn', '星辰公会', 'illidan-cn', '伊利丹'],
        ['kr', '즐거운공격대', 'azshara-kr', '아즈샤라'],
        ['eu', 'Égalité Sölvesborg', 'chants-eternels', 'Chants éternels'],
      ];
      rank(
        ...guildsOn(3, 21_000).map((entry, index) => ({
          ...entry,
          region: names[index][0],
          name: names[index][1],
          realmSlug: names[index][2],
          realmName: names[index][3],
        })),
      );

      await rankings.refreshRaid(RAID);

      for (const [index, [region, name, realmSlug, realmName]] of names.entries()) {
        const lookup = { region, 'realm.slug': realmSlug, name };
        const found = await db.collection(GUILDS_COLLECTION).findOne(lookup);
        expect(found).toMatchObject({ id: 21_000 + index, realm: { name: realmName } });

        const plan = await db.collection(GUILDS_COLLECTION).find(lookup).explain('queryPlanner');
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('guild_region_realm_name');
      }
    });
  });

  describe('R5 and R6 yielding and failures', () => {
    it('R5.3 a wait that runs out ends the run, names why, and keeps what it read', async () => {
      // No wait for idle in this file, so a job that starts mid-run ends the run.
      let release: (() => Promise<void>) | undefined;
      app.raiderIo.beforeServe = (request) => {
        if (request.path !== 'raiding/raid-rankings' || request.page !== 0) return;
        if (!release && started().length === 2) release = holdActive(app.app, 'enrichment');
      };
      const before = await raid('the-venomous-abyss');

      await tick();

      const last = rankings.lastStatus.lastRun!;
      // The second board was being read when enrichment began, and finished.
      expect(last).toMatchObject({
        boards: 2,
        failed: 0,
        stopped: 'higher-priority work is still running',
      });
      expect(started()).toEqual(['the-venomous-abyss/world', 'the-venomous-abyss/us']);
      const after = await raid('the-venomous-abyss');
      expect(after.guildsUpdatedAt.us.mythic.getTime()).toBeGreaterThan(
        before.guildsUpdatedAt.us.mythic.getTime(),
      );
      expect(after.guildsUpdatedAt.eu.mythic, 'not reached').toEqual(
        before.guildsUpdatedAt.eu.mythic,
      );
      expect(
        logger.matching(/Raid rankings paused: a higher-priority job is running/),
      ).toHaveLength(1);
      expect(logger.matching(/Raid rankings gave up waiting/)).toHaveLength(1);
      expect(logger.matching(/stopped early: higher-priority work is still running/)).toHaveLength(
        1,
      );

      // The rest are read at the next tick.
      await release!();
      app.raiderIo.reset();
      await tick();
      expect(started()).toEqual(REGIONS.map((region) => `the-venomous-abyss/${region}`));
    });

    it('R5.7 while a job above it never finishes, no board is read, tick after tick', async () => {
      // Pinned, and accepted: the rankings are the lowest priority there is,
      // so an archive backfill that runs for hours holds them for hours.
      const release = holdActive(app.app, 'mplusArchive');

      for (let attempt = 0; attempt < 3; attempt += 1) await tick();
      expect(requests()).toEqual([]);

      await release();
      await tick();
      expect(started()).toHaveLength(5);
    });

    it('R6.2 a 404 on a board is an answer, as a 400 is: recorded, and not an outage', async () => {
      rank();
      await forget('kr');
      app.raiderIo.failWith(`raiding/raid-rankings&raid:${RAID}&region:kr`, { status: 404 });

      const result = await rankings.refreshDue();

      expect(result).toMatchObject({ failed: 1, refused: 1, stopped: null });
      const stored = await raid();
      expect(stored.guildsRefusedAt.kr.mythic).toBeInstanceOf(Date);
      expect(stored.guilds.kr, 'no board is invented for it').toEqual({});

      app.raiderIo.reset();
      await rankings.refreshDue();
      expect(asked(), 'a finished raid refused board is not asked for again').toEqual([]);

      // Until it is read by hand, which clears the refusal.
      await rankings.refreshRaid(RAID);
      expect((await raid()).guildsRefusedAt.kr).toEqual({});
      expect(await board('kr')).toEqual([]);
    });

    it('R6.4 an empty 200 on a page fails the board whole; it is not stored as empty', async () => {
      rank(...guildsOn(30, 22_000));
      await rankings.refreshRaid(RAID);
      const before = await raid();

      rank(...guildsOn(30, 23_000));
      app.raiderIo.failWith(`raiding/raid-rankings&raid:${RAID}&region:us&page:1`, {
        empty: true,
        times: 1,
      });
      const result = await rankings.refreshRaid(RAID);

      expect(result).toMatchObject({ boards: 4, failed: 1, refused: 0 });
      const after = await raid();
      expect(after.guilds.us.mythic).toEqual(before.guilds.us.mythic);
      expect(after.guilds.us.mythic).toHaveLength(30);
      expect(
        logger.of('warn', /Could not read the us mythic ranking of tier-mn-1: .*empty response/),
      ).toHaveLength(1);
    });

    it('R6.5 Mongo failing on board writes stops the run after three, and the scheduler survives', async () => {
      const repository = app.app.get(RaidRankingsRepository);
      vi.spyOn(repository, 'setBoard').mockRejectedValue(new Error('mongo is gone'));

      await tick();

      expect(rankings.lastStatus.lastRun).toMatchObject({
        boards: 0,
        failed: 3,
        stopped: '3 boards in a row could not be read',
      });
      expect(logger.of('error')).toEqual([]);

      vi.restoreAllMocks();
      app.raiderIo.reset();
      await tick();
      expect(rankings.lastStatus.lastRun).toMatchObject({ boards: 5, failed: 0, stopped: null });
    });
  });

  describe('R7 health and admin', () => {
    it('R7.1 liveness reports the ranking job, and readiness the endpoint apart from Raider.io', async () => {
      app.raiderIo.failWith(`raiding/raid-rankings&raid:${RAID}&region:us`, { status: 504 });
      await rankings.refreshRaid(RAID);

      const health = await getJson<{ jobs: Record<string, unknown> }>(app.url(), '/health');
      expect(health.body.jobs.raidRankingsRunning).toBe(false);
      expect(health.body.jobs.raidRankings).toEqual({
        boards: 4,
        failed: 1,
        refused: 0,
        settled: 0,
        raids: 1,
        guilds: expect.any(Number),
        stopped: null,
        finishedAt: expect.any(String),
      });

      const ready = await getJson<{
        status: string;
        dependencies: Record<string, { status: string; failingRegions: string[] }>;
      }>(app.url(), '/health/ready');
      // Seen, and named, where an operator looks for it...
      expect(ready.body.dependencies.raiderioRankings).toMatchObject({
        status: 'degraded',
        failingRegions: ['us'],
      });
      // ...and not held against Raider.io, whose `us` is the Mythic+ region.
      expect(ready.body.dependencies.raiderio.failingRegions).toEqual([]);
      expect(ready.body.status).toBe('ok');
    });

    it('R7.3 ?raid= for an unknown or unlisted raid is a 404 that asks Raider.io nothing', async () => {
      await db
        .collection(RAIDS_COLLECTION)
        .updateOne({ slug: 'manaforge-omega' }, { $set: { unlistedAt: new Date() } });

      for (const slug of ['no-such-raid', 'manaforge-omega']) {
        const response = await postJson(app.url(), `/admin/raid-rankings?raid=${slug}`);
        expect(response.status, slug).toBe(404);
      }
      expect(app.raiderIo.requests).toEqual([]);

      await db
        .collection(RAIDS_COLLECTION)
        .updateOne({ slug: 'manaforge-omega' }, { $unset: { unlistedAt: '' } });
    });

    it('holds every invariant, the boards against the world included', async () => {
      for (const entry of world.raids) await rankings.refreshRaid(entry.slug);

      await expectInvariants(db, undefined, world);
    });
  });
});
