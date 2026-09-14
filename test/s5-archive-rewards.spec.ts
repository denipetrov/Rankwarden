import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ArchiveService } from '../src/archive/archive.service.js';
import {
  ARCHIVE_SEASONS_COLLECTION,
  type ArchiveSeasonDocument,
  type ArchiveSeasonReward,
} from '../src/archive/entities/archive.entity.js';
import { withRunId } from '../src/common/logging/run-context.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { SPECS, World } from './support/world.js';

/** The live season, ended, so the archive takes it too. Archived in full. */
const COMPLETE = 42;
/** Blizzard refuses its bracket list, as it does for seasons 22–26. */
const REFUSED = 41;
/** One ladder keeps failing, so its standings are archived only in part. */
const PARTIAL = 40;

/**
 * S5 — season rewards, the title cutoffs recorded on `archive_seasons`.
 *
 * Rewards are their own pass, driven by what the archive holds: only a season
 * whose standings are archived in full is asked about. The first tick is set up
 * so all three outcomes of the backlog are present at once — archived, refused,
 * partial — and only the first may cost a rewards request.
 *
 * The world publishes all 85 ladders, so all 40 specs are looked up, and the
 * four names two classes share ("Holy", "Frost", "Protection", "Restoration")
 * have to land on the right ladder. The expectation is built from the fake's
 * own payload and the spec table rather than from the mapping under test, so a
 * mapping that is consistently wrong still fails here.
 */
describe('S5 — season rewards', () => {
  let harness: TestApp;
  let db: Db;
  let world: World;
  /** The first tick's request log. */
  let tick: string[] = [];

  const markers = () => db.collection<ArchiveSeasonDocument>(ARCHIVE_SEASONS_COLLECTION);
  const marker = (seasonId: number) => markers().findOne({ seasonId, region: 'us' });
  const archive = () => harness.app.get(ArchiveService);
  const rewardsPass = () => withRunId('archive', () => archive().archivePendingRewards());
  const rewardsPath = (seasonId: number) => `data/wow/pvp-season/${seasonId}/pvp-reward/index`;
  const rewardRequests = (seasonId: number) =>
    harness.blizzard.requests.filter((request) => request.path === rewardsPath(seasonId)).length;
  const forget = (seasonId: number) =>
    markers().updateOne(
      { seasonId, region: 'us' },
      { $unset: { rewards: '', rewardsFetchedAt: '', rewardsFailed: '' } },
    );

  /** What the fake served for a season, attached to ladders by hand. */
  const expectedRewards = (seasonId: number) => {
    const served = world.rewardsPayload('us', seasonId)!.rewards as {
      bracket: { type: string };
      achievement: { name: string };
      rating_cutoff: number;
      faction?: { type: string };
      specialization?: { id: number };
    }[];
    const family: Record<string, string> = { SHUFFLE: 'shuffle', BLITZ: 'blitz' };
    const core: Record<string, string> = { ARENA_3v3: '3v3', BATTLEGROUNDS: 'rbg' };

    return served
      .map((reward) => {
        const spec = SPECS.find((entry) => entry.specId === reward.specialization?.id);

        return {
          bracket:
            core[reward.bracket.type] ??
            `${family[reward.bracket.type]}-${spec!.classSlug}-${spec!.specSlug}`,
          faction: reward.faction?.type ?? null,
          ratingCutoff: reward.rating_cutoff,
          title: reward.achievement.name,
        };
      })
      .sort((a, b) => `${a.bracket}/${a.faction}`.localeCompare(`${b.bracket}/${b.faction}`));
  };

  const stored = (rewards: ArchiveSeasonReward[] | undefined) =>
    (rewards ?? [])
      .map(({ bracket, faction, ratingCutoff, title }) => ({
        bracket,
        faction,
        ratingCutoff,
        title,
      }))
      .sort((a, b) => `${a.bracket}/${a.faction}`.localeCompare(`${b.bracket}/${b.faction}`));

  beforeAll(async () => {
    world = World.seed({ regions: ['us'], players: 30, seed: 53, season: COMPLETE });
    world.endSeason('us', new Date('2026-09-01T05:00:00.000Z'));
    world.fail('us', `brackets:${REFUSED}`, 403);
    world.fail('us', `ladder:${PARTIAL}/rbg`, 503);

    harness = await bootTestApp(world, {
      SEASON_REFRESH_ENABLED: 'true',
      ARCHIVE_ENABLED: 'true',
      ARCHIVE_MIN_SEASON: String(PARTIAL),
      ARCHIVE_MAX_SEASON: String(COMPLETE),
      ARCHIVE_REQUESTS_PER_SECOND: '1000',
      ARCHIVE_CONCURRENCY: '4',
      // No pause between seasons, so a tick that kept re-offering the same
      // season would spin as fast as the fake can answer.
      ARCHIVE_SEASON_PAUSE_MS: '0',
    });
    db = harness.app.get(MongoService).db;
    await harness.settle();

    // The sweep warms the coordinator up, which releases the archive's tick:
    // the backlog, then the rewards pass.
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();

    tick = harness.blizzard.requests.map((request) => request.path);
    world.clearFaults();
    world.fail('us', `brackets:${REFUSED}`, 403);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('the first tick', () => {
    it('fetches rewards for the season it archived in full', async () => {
      const complete = await marker(COMPLETE);

      expect(tick.filter((path) => path === rewardsPath(COMPLETE))).toHaveLength(1);
      expect(complete!.rewardsFetchedAt).toBeInstanceOf(Date);
      // 3v3 once, rbg per faction, shuffle per spec, blitz per spec and faction:
      // 1 + 2 + 40 + 80, the same 123 a live season carries.
      expect(complete!.rewards).toHaveLength(123);
      expect(stored(complete!.rewards)).toEqual(expectedRewards(COMPLETE));
    });

    it('never asks about a season that is not in the archive at all', async () => {
      expect(await marker(REFUSED), 'no marker: Blizzard refused its ladders').toBeNull();
      expect(tick.filter((path) => path === rewardsPath(REFUSED))).toEqual([]);
    });

    it('does not ask about a season archived only in part', async () => {
      const partial = await marker(PARTIAL);

      expect(partial!.failedBrackets).toEqual(['rbg']);
      expect(tick.filter((path) => path === rewardsPath(PARTIAL))).toEqual([]);
    });

    it('does not spin on the partial season within the tick', () => {
      // It goes back into the backlog for the next tick, not this one. Before,
      // `nextPending` handed it straight back and, with no pause between
      // seasons, the failing ladder was re-fetched until the archive's share of
      // the quota was gone.
      expect(
        tick.filter((path) => path === `data/wow/pvp-season/${PARTIAL}/pvp-leaderboard/rbg`),
      ).toHaveLength(1);
    });

    it('looks each spec up once, in the static namespace', () => {
      const lookups = harness.blizzard.requests.filter((request) =>
        request.path.startsWith('data/wow/playable-specialization/'),
      );

      expect(lookups).toHaveLength(SPECS.length);
      expect(new Set(lookups.map((request) => request.namespace))).toEqual(new Set(['static-us']));
    });
  });

  it('keeps the specs that share a name on their own class', async () => {
    const holy = (await marker(COMPLETE))!.rewards!.filter(
      (reward) => reward.specialization?.name === 'Holy' && reward.bracket.startsWith('shuffle-'),
    );

    expect(holy.map((reward) => reward.bracket).sort()).toEqual([
      'shuffle-paladin-holy',
      'shuffle-priest-holy',
    ]);
  });

  it('fetches the rewards once the partial season completes, for one request', async () => {
    const result = await withRunId('archive', () => archive().archiveSeason(PARTIAL, 'us'));
    expect(result.failedBrackets).toEqual([]);
    harness.blizzard.reset();

    await expect(rewardsPass()).resolves.toEqual({ seasons: 1, fetched: 1, failed: 0, pending: 0 });

    // No bracket list, no season record, no spec lookup: the ladders the
    // rewards are placed against come from the archive itself.
    expect(harness.blizzard.requests.map((request) => request.path)).toEqual([
      rewardsPath(PARTIAL),
    ]);
    expect(stored((await marker(PARTIAL))!.rewards)).toEqual(expectedRewards(PARTIAL));
  });

  it('fills in rewards for a season archived before they were recorded', async () => {
    // What every marker written by an earlier build looks like.
    await forget(COMPLETE);
    harness.blizzard.reset();

    await expect(rewardsPass()).resolves.toMatchObject({ fetched: 1 });
    expect(rewardRequests(COMPLETE)).toBe(1);
    expect(stored((await marker(COMPLETE))!.rewards)).toEqual(expectedRewards(COMPLETE));
  });

  it('records a 403 as failed and never asks again', async () => {
    await forget(COMPLETE);
    world.fail('us', `rewards:${COMPLETE}`, 403);
    harness.blizzard.reset();

    await expect(rewardsPass()).resolves.toEqual({ seasons: 1, fetched: 0, failed: 1, pending: 0 });

    const refused = await marker(COMPLETE);
    expect(refused!.rewardsFailed).toMatchObject({ statusCode: 403, at: expect.any(Date) });
    expect(refused!.rewardsFailed!.reason).toMatch(/403/);
    expect(refused).not.toHaveProperty('rewards');
    // The standings are untouched: a refused reward costs the reward only.
    expect(refused!.failedBrackets).toEqual([]);

    world.clearFaults();
    world.fail('us', `brackets:${REFUSED}`, 403);

    await expect(rewardsPass()).resolves.toEqual({ seasons: 0, fetched: 0, failed: 0, pending: 0 });
    expect(rewardRequests(COMPLETE), 'asked once, even with Blizzard answering again').toBe(1);
  });

  it('retries a 5xx on the next pass instead of recording it', async () => {
    await forget(COMPLETE);
    world.fail('us', `rewards:${COMPLETE}`, 503);

    await expect(rewardsPass()).resolves.toEqual({ seasons: 1, fetched: 0, failed: 0, pending: 1 });
    const pending = await marker(COMPLETE);
    expect(pending).not.toHaveProperty('rewardsFailed');
    expect(pending).not.toHaveProperty('rewardsFetchedAt');

    world.clearFaults();
    world.fail('us', `brackets:${REFUSED}`, 403);

    await expect(rewardsPass()).resolves.toMatchObject({ fetched: 1 });
  });

  it('can be driven from the dev-only admin trigger', async () => {
    await forget(PARTIAL);

    const response = await postJson<{ fetched: number }>(
      await harness.listen(),
      '/admin/archive-rewards',
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ seasons: 1, fetched: 1, failed: 0, pending: 0 });
  });
});
