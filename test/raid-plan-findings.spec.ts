import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { RaidCatalogueService } from '../src/raid/raid-catalogue.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld, type WorldGuild } from './support/mplus-world.js';
import { World } from './support/world.js';
import { RAIDS_COLLECTION } from '../src/database/collections.js';

/**
 * One case per defect the raid and guild test plan found (2026-10-05), each
 * asserting the behaviour wanted. They failed until the defects were fixed and
 * are regression guards now.
 *
 * The case names keep the numbers they were written under, which differ from
 * the plan's: RG2 here is the plan's RG4 (a refused board), RG3 its RG5 (a run
 * by hand), RG4 its RG3 (readiness), RG6 its RG2 (the catalogue's 400) and RG5
 * its RG6 (liveness).
 */
const RAID = 'tier-mn-1';

function guildsOn(count: number, firstId: number): WorldGuild[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    name: `Guild ${firstId + index}`,
    faction: 'horde' as const,
    region: 'us',
    realmSlug: 'stormrage',
    realmName: 'Stormrage',
    progress: {
      [RAID]: [
        {
          slug: 'first-boss',
          pulls: 10,
          defeatedAt: new Date(Date.parse('2026-03-20T00:00:00Z') + index * 60_000).toISOString(),
        },
      ],
    },
  }));
}

describe('Raid plan findings', () => {
  let app: TestApp;
  let db: Db;
  let rankings: RaidRankingsService;
  const world = new MplusWorld();

  const rankingRequests = () =>
    app.raiderIo.requests.filter((request) => request.path === 'raiding/raid-rankings');
  const board = async (region: string) =>
    ((await db.collection(RAIDS_COLLECTION).findOne({ slug: RAID }))!.guilds?.[region]?.mythic ??
      []) as { rank: number; guildId: number }[];

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAID_CATALOGUE_ENABLED: 'true', RAID_RANKINGS_ENABLED: 'true' },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
    rankings = app.app.get(RaidRankingsService);
    await app.settle();
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
    await app.listen();
  });

  afterEach(() => app.raiderIo.reset());
  afterAll(() => app?.close());

  it('RG1 a rank upstream does not serve leaves a short page, and the board goes on past it', async () => {
    // 97 guilds served of ranks 1-100, as The Emerald Nightmare is live:
    // ranks 8, 66 and 83 are held by guilds upstream does not show.
    world.guilds.push(...guildsOn(100, 70_000));
    for (const rank of [8, 66, 83]) {
      world.guilds.find((guild) => guild.id === 70_000 + rank - 1)!.notServed = true;
    }

    await rankings.refreshRaid(RAID);
    const us = await board('us');

    expect(us.length, 'every served guild of the top hundred is stored').toBe(97);
    expect(us.at(-1)!.rank).toBe(100);
    await expectInvariants(db, undefined, world);
  });

  it('RG2 a board Raider.io refuses with a 400 is not asked for again every run', async () => {
    const refused = `raiding/raid-rankings&raid:${RAID}&difficulty:mythic&region:kr`;
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne({ slug: RAID }, { $unset: { 'guildsUpdatedAt.kr.mythic': '' } });
    app.raiderIo.failWith(refused, { status: 400 });
    await rankings.refreshRaid(RAID);
    app.raiderIo.reset();
    app.raiderIo.failWith(refused, { status: 400 });

    // The raid is finished, and every other board of it is settled.
    await rankings.refreshDue();
    await rankings.refreshDue();

    expect(
      rankingRequests().filter((request) => request.params.raid === RAID),
      'a 400 does not change with time',
    ).toHaveLength(0);
  });

  it('RG3 a run asked for by hand is not held back by a scheduled run waiting to go on', async () => {
    let release!: (clear: boolean) => void;
    const held = new Promise<boolean>((resolve) => (release = resolve));
    await db
      .collection(RAIDS_COLLECTION)
      .updateOne({ slug: RAID }, { $unset: { 'guildsUpdatedAt.us.mythic': '' } });

    const scheduled = rankings.refreshDue(new Date(), { whenClear: () => held });
    const byHand = rankings.refreshDue();
    const first = await Promise.race([
      byHand.then(() => 'by hand'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 1_000)),
    ]);
    release(true);
    await Promise.all([scheduled, byHand]);

    expect(first, 'POST /admin/raid-rankings is documented as not held back').toBe('by hand');
  });

  it('RG4 failing ranking boards do not report Raider.io as down for Mythic+ regions', async () => {
    app.raiderIo.failWith('raiding/raid-rankings', { status: 504 });
    await rankings.refreshRaid(RAID);

    const ready = await getJson<{
      status: string;
      dependencies: { raiderio: { status: string; failingRegions: string[] } };
    }>(app.url(), '/health/ready');

    expect(
      ready.body.dependencies.raiderio.failingRegions,
      JSON.stringify(ready.body.dependencies.raiderio),
    ).not.toContain('world');
    expect(ready.body.status, 'a slow ranking endpoint is not a degraded service').toBe('ok');
  });

  it('RG6 a catalogue walk that ended normally does not leave Raider.io reported as failing', async () => {
    app.raiderIo.reset();
    await app.app.get(RaidCatalogueService).refresh();

    const ready = await getJson<{
      dependencies: { raiderio: { status: string; failingRegions: string[] } };
    }>(app.url(), '/health/ready');

    // The 400 for the first unsupported expansion is how the list ends.
    expect(ready.body.dependencies.raiderio.failingRegions).not.toContain('global');
  });

  it('RG5 liveness reports the raid jobs, as it does every other job', async () => {
    const health = await getJson<{ jobs: Record<string, unknown> }>(app.url(), '/health');

    expect(Object.keys(health.body.jobs).filter((key) => /raid/i.test(key))).not.toEqual([]);
  });
});
