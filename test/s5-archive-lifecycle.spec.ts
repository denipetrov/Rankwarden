import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  ARCHIVE_BRACKETS_COLLECTION,
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import { ArchiveService } from '../src/archive/archive.service.js';
import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { AGGREGATE_BRACKETS, CORE_BRACKETS, SPECS, World } from './support/world.js';

/** Enough spec ladders that a season costs more requests than the token burst. */
const SPEC_LADDERS = SPECS.slice(0, 6).map((spec) => `shuffle-${spec.classSlug}-${spec.specSlug}`);
const INGESTABLE = CORE_BRACKETS.length + SPEC_LADDERS.length;

const SEASON = 42;
/** History the World seeds behind the live season. */
const OLDER = 41;
const OLDEST = 40;

/**
 * S5 — the archive backlog as the scheduler actually works it.
 *
 * The archive is the lowest-priority job in the service: it waits for live
 * ingestion to warm up, yields to it mid-season, and has to survive a season
 * Blizzard has stopped serving without stranding everything behind it. None of
 * that is visible from `archiveSeason` alone, so these cases drive the real
 * scheduler and read the fake's request log.
 *
 * Three ingestable brackets rather than eighty-three: every case here counts
 * requests, and a four-figure request log makes a rate-limit assertion
 * unreadable without making it any stronger.
 */
describe('S5 — archive backlog and scheduling', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    ARCHIVE_ENABLED: 'true',
    ARCHIVE_MAX_ENTRIES_PER_BRACKET: '5',
    ARCHIVE_MIN_SEASON: String(OLDEST),
    ARCHIVE_MAX_SEASON: String(SEASON),
    ARCHIVE_REQUESTS_PER_SECOND: '5',
    ARCHIVE_SEASON_PAUSE_MS: '120',
    ARCHIVE_CONCURRENCY: '2',
  };

  let harness: TestApp;
  let db: Db;
  let world: World;
  /** The backlog's own request log, taken before any case resets it. */
  let backlogRequests: { path: string; at: number }[] = [];

  const entries = () => db.collection(ARCHIVE_ENTRIES_COLLECTION);
  const markers = () => db.collection(ARCHIVE_SEASONS_COLLECTION);
  const fetched = () => db.collection(ARCHIVE_BRACKETS_COLLECTION);
  const archive = () => harness.app.get(ArchiveService);

  /** Ladder fetches only — the bracket index shares the path fragment. */
  const ladderFetches = (seasonId?: number) =>
    harness.blizzard.requests.filter(
      (request) =>
        request.path.includes('/pvp-leaderboard/') &&
        !request.path.endsWith('/pvp-leaderboard/index') &&
        (seasonId === undefined || request.path.includes(`pvp-season/${seasonId}/`)),
    );

  beforeAll(async () => {
    world = World.seed({
      regions: ['us'],
      players: 24,
      seed: 51,
      season: SEASON,
      brackets: [...CORE_BRACKETS, ...AGGREGATE_BRACKETS, ...SPEC_LADDERS],
    });
    // Blizzard has stopped serving season 41's bracket list. It sits in the
    // middle of the backlog, which is what makes it able to strand seasons.
    world.fail('us', `brackets:${OLDER}`, 404);
    world.endSeason('us', new Date('2026-09-01T05:00:00.000Z'));

    harness = await bootTestApp(world, ENV);
    db = harness.app.get(MongoService).db;
    await harness.settle();

    // The sweep warms the coordinator up, which is what releases the archive.
    // Enrichment is disabled in this file, so the sweep alone is enough.
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
    await harness.settle();
    backlogRequests = harness.blizzard.requests
      .map((request) => ({ path: request.path, at: request.at }))
      .sort((left, right) => left.at - right.at);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S5.10 — a permanently 404ing season does not strand the backlog', async () => {
    const stranded = await markers().findOne({ seasonId: OLDER, region: 'us' });

    expect(stranded, 'the unservable season is recorded rather than retried forever').toBeTruthy();
    expect(stranded!.unarchivable).toBe(true);
    expect(String(stranded!.lastError)).toMatch(/404/);

    // The point of `failedThisTick`: everything behind the failure is still
    // reached in the same tick, rather than the backlog stopping dead at it.
    for (const seasonId of [SEASON, OLDEST]) {
      const marker = await markers().findOne({ seasonId, region: 'us' });
      expect(
        marker,
        `season ${seasonId} sits behind the failure and must be archived`,
      ).toBeTruthy();
      expect(marker!.failedBrackets).toEqual([]);
    }

    expect(await archive().nextPending(), 'the backlog is empty').toBeNull();
  });

  it('S5.10b — and it is never attempted a second time', async () => {
    harness.blizzard.reset();
    await archive().nextPending();

    expect(
      harness.blizzard.requests.filter((request) => request.path.includes(`pvp-season/${OLDER}`)),
      'an unarchivable season costs nothing on every later tick',
    ).toEqual([]);
  });

  it('S5.11 — every archive request goes through the same bucket', async () => {
    // Leaderboards, the bracket index and the season record all count against
    // it. Measured on an archive run of its own: the sweep has a separate
    // limiter, and a log holding both would say nothing about either.
    await markers().deleteMany({ seasonId: OLDEST, region: 'us' });
    await fetched().deleteMany({ seasonId: OLDEST, region: 'us' });
    await entries().deleteMany({ seasonId: OLDEST, region: 'us' });
    harness.blizzard.reset();

    await archive().archiveSeason(OLDEST, 'us');

    const times = harness.blizzard.requests.map((request) => request.at).sort((a, b) => a - b);
    expect(
      times.length,
      'the bracket index and the season record are in here alongside the ladders',
    ).toBe(INGESTABLE + 2);

    let worst = 0;
    for (const [index, at] of times.entries()) {
      worst = Math.max(worst, times.slice(index).filter((other) => other - at < 1000).length);
    }

    // 5/s configured, and eleven requests to make — more than the bucket can
    // ever hold, so the limiter has to actually throttle rather than let one
    // burst cover the whole season.
    expect(worst, `${worst} requests landed inside one second`).toBeLessThanOrEqual(7);
  });

  it('S5.11b — and the scheduler pauses between seasons', async () => {
    // A lower bound taken from the backlog run: rate limiting can only widen
    // these gaps, so the assertion cannot fail for the wrong reason.
    const seasonOf = (path: string) => Number(/pvp-season\/(\d+)/.exec(path)?.[1] ?? 0);
    const spans = new Map<number, { first: number; last: number }>();

    for (const request of backlogRequests) {
      const seasonId = seasonOf(request.path);
      const span = spans.get(seasonId);
      if (span) span.last = Math.max(span.last, request.at);
      else spans.set(seasonId, { first: request.at, last: request.at });
    }

    const ordered = [...spans.entries()]
      .filter(([seasonId]) => seasonId === SEASON || seasonId === OLDEST)
      .sort((left, right) => left[1].first - right[1].first);
    expect(ordered.length, 'the backlog covered more than one season').toBe(2);

    const gap = ordered[1][1].first - ordered[0][1].last;
    expect(gap, `only ${gap}ms between seasons`).toBeGreaterThanOrEqual(120);
  });

  it('S5.5 — re-archiving a season is idempotent', async () => {
    const before = await entries().countDocuments({ seasonId: SEASON, region: 'us' });
    expect(before).toBeGreaterThan(0);

    // Both the marker and the fetch record go, so the season is genuinely
    // re-fetched rather than skipped as already covered — otherwise this would
    // assert nothing about the write path absorbing a repeat.
    await markers().deleteMany({ seasonId: SEASON, region: 'us' });
    await fetched().deleteMany({ seasonId: SEASON, region: 'us' });

    const result = await archive().archiveSeason(SEASON, 'us');

    expect(result.failedBrackets).toEqual([]);
    expect(
      await entries().countDocuments({ seasonId: SEASON, region: 'us' }),
      'the unique identity index plus upsert absorbs the repeat',
    ).toBe(before);
  });

  it('S5.6 — a lost marker is recovered without re-fetching a single ladder', async () => {
    const before = await entries().countDocuments({ seasonId: SEASON, region: 'us' });

    // The markers for everything that was archived are gone: a dropped
    // collection, or a restore from a backup that predates them. Season 41's
    // marker stays, because it records something no amount of stored data could
    // re-derive — that Blizzard will never serve it.
    await markers().deleteMany({ seasonId: { $ne: OLDER } });
    harness.blizzard.reset();

    const pending = await archive().nextPending();

    expect(pending, 'every season is recognised from what is already stored').toBeNull();
    expect(
      ladderFetches(),
      'recovery must cost the bracket list, not the ladders behind it',
    ).toEqual([]);
    expect(await entries().countDocuments({ seasonId: SEASON, region: 'us' })).toBe(before);

    const restored = await markers().findOne({ seasonId: SEASON, region: 'us' });
    expect(restored!.failedBrackets, 'and the marker is written back').toEqual([]);
  });

  it('S5.8 — live ingestion pre-empts an archive in progress', async () => {
    await markers().deleteMany({ seasonId: SEASON, region: 'us' });
    await entries().deleteMany({ seasonId: SEASON, region: 'us' });
    await fetched().deleteMany({ seasonId: SEASON, region: 'us' });
    harness.blizzard.reset();

    // A sweep holds the coordinator for the duration of the archive run, which
    // is the state an archive that started just before a sweep finds itself in.
    const result = await harness.app
      .get(IngestionCoordinator)
      .duringSweep(() => archive().archiveSeason(SEASON, 'us'));

    expect(result.failedBrackets.length, 'every bracket yields immediately').toBe(INGESTABLE);
    expect(result.entries).toBe(0);
    expect(
      ladderFetches(SEASON),
      'yielding means issuing no request at all, not discarding the response',
    ).toEqual([]);

    // The season stays pending, so a later tick picks it up where it stopped.
    const marker = await markers().findOne({ seasonId: SEASON, region: 'us' });
    expect(marker!.failedBrackets.sort()).toEqual([...CORE_BRACKETS, ...SPEC_LADDERS].sort());
    expect(await archive().nextPending()).toEqual({ seasonId: SEASON, region: 'us' });
  });

  it('S5.8b — and the next tick completes it and clears the failures', async () => {
    const result = await archive().archiveSeason(SEASON, 'us');

    expect(result.failedBrackets).toEqual([]);
    expect(result.entries).toBeGreaterThan(0);

    const marker = await markers().findOne({ seasonId: SEASON, region: 'us' });
    expect(marker!.failedBrackets).toEqual([]);
    expect(await archive().nextPending()).toBeNull();
  });

  it('S5.12 — missing season metadata does not abort the archive', async () => {
    await markers().deleteMany({ seasonId: SEASON, region: 'us' });
    await entries().deleteMany({ seasonId: SEASON, region: 'us' });
    await fetched().deleteMany({ seasonId: SEASON, region: 'us' });

    // The standings are served; only the season record itself has gone.
    world.fail('us', 'season', 404);

    try {
      const result = await archive().archiveSeason(SEASON, 'us');

      expect(result.failedBrackets, 'the standings are what matter').toEqual([]);
      expect(result.entries).toBeGreaterThan(0);

      const marker = await markers().findOne({ seasonId: SEASON, region: 'us' });
      expect(marker!.name ?? null, 'no name to record').toBeNull();
      expect(marker!.startsAt).toBeNull();
      expect(marker!.endsAt).toBeNull();
      expect(marker!.failedBrackets, 'and the season still counts as complete').toEqual([]);
    } finally {
      world.clearFaults();
      world.fail('us', `brackets:${OLDER}`, 404);
    }
  });
});
