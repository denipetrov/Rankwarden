import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from '../src/mplus-season/mplus-season-events.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { getJson, postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const LIVE = 'season-mn-2';
const FINISHED = 'season-mn-1';
const UNSERVED = 'season-mn-0';

interface SweepBody {
  seasons: Record<string, string>;
  startedAt: string;
  durationMs: number;
  regions: { region: string; stoppedEarly: string | null }[];
  runs: number;
  characters: number;
  requests: number;
  stoppedEarly: string | null;
  skipped?: string;
}

/**
 * M12.1-M12.5, M12.7, M12.8, M12.10 — the five `POST /admin/mplus*` routes,
 * which had no test at all (gap §7.1), and what `/health` and `/health/ready`
 * say about Mythic+ (gap §7.5).
 *
 * The routes exist for rehearsals: each drives exactly one cycle and hands back
 * that cycle's own result. So each is checked for the result it returns, for
 * refusing to run twice at once, and for charging its requests to the right
 * consumer. M12.9, the Mythic+ half of `/health/seasons`, is in
 * `mplus-lifecycle.spec.ts` as M5.9.
 */
describe('Mythic+ admin routes and health', () => {
  let app: TestApp;
  let db: Db;
  let budget: RaiderIoBudget;
  const logger = new CapturingLogger();
  const world = new MplusWorld();
  const events: MplusSeasonTransitionEvent[] = [];

  const post = <T>(path: string) => postJson<T>(app.url(), path);
  const staleUsRuns = async () => {
    const rows = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .find({ season: LIVE, region: 'us' }, { projection: { _id: 0 } })
      .limit(3)
      .toArray();
    await db
      .collection(MPLUS_RUNS_COLLECTION)
      .insertMany(rows.map((row) => ({ ...row, season: FINISHED })));
  };

  beforeAll(async () => {
    world.seasons.push({
      slug: UNSERVED,
      name: 'MN Season 0',
      blizzardSeasonId: 16,
      isMainSeason: true,
      starts: { us: '2025-09-01T15:00:00Z' },
      ends: { us: '2026-03-01T15:00:00Z' },
      dungeons: 8,
    });
    world.unservedSeasons.add(UNSERVED);
    world.seed('us', 40, 500, LIVE).seed('us', 60, 450, FINISHED);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_PURGE_DRY_RUN: 'true', MPLUS_PURGE_REQUIRE_ARCHIVE: 'false' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
    budget = app.app.get(RaiderIoBudget);
    app.app.get(MplusSeasonEvents).transitions$.subscribe((event) => events.push(event));
    await app.listen();
  });

  afterEach(async () => {
    await releaseAllHolds();
    vi.restoreAllMocks();
    app.raiderIo.reset();
    logger.clear();
    events.length = 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M12.1 POST /admin/mplus runs one pass, refuses a second, and charges the pass to itself', async () => {
    app.raiderIo.delayMs = 20;
    const before = { mplus: budget.spent('mplus'), other: budget.spent('other') };

    const [first, second] = await Promise.all([
      post<SweepBody>('/admin/mplus'),
      new Promise((resolve) => setTimeout(resolve, 5)).then(() => post<SweepBody>('/admin/mplus')),
    ]);

    expect(first.status).toBe(201);
    expect(Object.keys(first.body).sort()).toEqual(
      [
        'characters',
        'durationMs',
        'regions',
        'requests',
        'runs',
        'seasons',
        'startedAt',
        'stoppedEarly',
      ].sort(),
    );
    expect(first.body.seasons).toEqual({ us: LIVE });
    expect(first.body.stoppedEarly).toBeNull();
    expect(second.body).toEqual({ skipped: 'a Mythic+ pass is already in progress' });

    // Every request is the one pass's, and it is charged to the pass.
    expect(first.body.requests).toBe(app.raiderIo.requests.length);
    expect(budget.spent('mplus') - before.mplus).toBe(first.body.requests);
    expect(budget.spent('other')).toBe(before.other);
  });

  it('M12.5 POST /admin/mplus-catalogue walks every expansion even when fresh, charged to other', async () => {
    const before = { mplus: budget.spent('mplus'), other: budget.spent('other') };

    const response = await post<{
      refreshed: boolean;
      expansions: number[];
      reason: string | null;
    }>('/admin/mplus-catalogue');

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ refreshed: true, expansions: [11], reason: null });
    expect(app.raiderIo.countMatching('static-data'), 'Midnight, and the empty one after').toBe(2);
    expect(budget.spent('other') - before.other).toBe(2);
    expect(budget.spent('mplus')).toBe(before.mplus);
  });

  it('M12.3 POST /admin/mplus-season-transition honours the dry run, and does not wait for a pass', async () => {
    await staleUsRuns();
    const stored = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: FINISHED });

    const dry = await post<{
      plan: { permitted: boolean; dryRun: boolean };
      purged: {
        season: string;
        region: string;
        dryRun: boolean;
        removed: Record<string, number>;
      }[];
    }>('/admin/mplus-season-transition');

    expect(dry.body.plan).toMatchObject({ permitted: true, dryRun: true });
    expect(dry.body.purged).toEqual([
      expect.objectContaining({ season: FINISHED, region: 'us', dryRun: true }),
    ]);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: FINISHED })).toBe(
      stored,
    );
    // M12.10: a purge is a warning, with its counts.
    expect(
      logger.of(
        'warn',
        /\[dry run\] Would retire Mythic\+ season season-mn-1 us .*: 3 run\(s\), 0 character\(s\)/,
      ),
    ).toHaveLength(1);

    // During a pass it abstains at once, unlike the scheduler's rollover tick.
    holdActive(app.app, 'mplus');
    const startedAt = Date.now();
    const during = await post<{ plan: { permitted: boolean; reason: string }; purged: unknown[] }>(
      '/admin/mplus-season-transition',
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(during.body.plan).toMatchObject({
      permitted: false,
      reason: 'a Mythic+ pass is running',
    });
    expect(during.body.purged).toEqual([]);

    await db.collection(MPLUS_RUNS_COLLECTION).deleteMany({ season: FINISHED });
  });

  it('M12.4 POST /admin/mplus-archive runs whatever else is active, and refuses to run twice', async () => {
    // Driven directly, so it starts under a running sweep — and stops at once.
    const release = holdActive(app.app, 'sweep');
    const blocked = await post<{ seasons: unknown[]; stoppedEarly: string | null }>(
      '/admin/mplus-archive',
    );
    expect(blocked.body).toMatchObject({
      seasons: [],
      stoppedEarly: 'a higher-priority job is running',
    });
    await release();

    app.raiderIo.delayMs = 20;
    const [first, second] = await Promise.all([
      post<{
        seasons: { season: string; outcome: string }[];
        pending: number;
        stoppedEarly: string | null;
      }>('/admin/mplus-archive'),
      new Promise((resolve) => setTimeout(resolve, 5)).then(() =>
        post<{ skipped?: string }>('/admin/mplus-archive'),
      ),
    ]);

    expect(second.body).toEqual({ skipped: 'a Mythic+ archive tick is already in progress' });
    expect(first.body.stoppedEarly).toBeNull();
    expect(first.body.seasons.map((season) => [season.season, season.outcome])).toEqual([
      [FINISHED, 'complete'],
      [UNSERVED, 'unarchivable'],
    ]);
    expect(first.body.pending).toBe(0);

    // M12.10: one summary line for the tick, and an expected failure — a season
    // Raider.io does not serve — is a warning with no stack.
    expect(
      logger.matching(/Mythic\+ archive tick: 2 season\(s\) attempted, 0 still pending/),
    ).toHaveLength(1);
    const unserved = logger.of('warn', /does not serve Mythic\+ season season-mn-0/);
    expect(unserved).toHaveLength(1);
    expect(unserved[0].detail).not.toMatch(/\n\s+at /);
    expect(logger.of('error')).toEqual([]);
  });

  it('M12.7 /health carries the Mythic+ season and job state, from memory', async () => {
    await post('/admin/mplus');
    const mongo = app.app.get(MongoService);
    const collection = vi.spyOn(mongo, 'collection');
    const ping = vi.spyOn(mongo, 'ping');

    const release = holdActive(app.app, 'mplus');
    const live = await getJson<{
      mplusSeasons: Record<
        string,
        { season: string; startsAt: string; endsAt: string | null; ended: boolean }
      >;
      jobs: {
        mplusRunning: boolean;
        mplusArchiveRunning: boolean;
        mplusArchive: { lastTickAt: string | null; lastTick: { seasons: number } | null };
      };
    }>(app.url(), '/health');
    await release();

    expect(live.body.mplusSeasons.us).toMatchObject({
      season: LIVE,
      startsAt: '2026-08-18T15:00:00.000Z',
      endsAt: '2030-01-01T00:00:00.000Z',
      ended: false,
    });
    expect(live.body.jobs.mplusRunning).toBe(true);
    expect(live.body.jobs.mplusArchiveRunning).toBe(false);
    expect(live.body.jobs.mplusArchive.lastTickAt).not.toBeNull();
    expect(live.body.jobs.mplusArchive.lastTick).toMatchObject({ seasons: 2 });
    expect(collection, 'liveness reads no collection').not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('M12.8 /health/ready turns each Mythic+ problem into exactly one line', async () => {
    type Ready = {
      status: string;
      mplus: { problems: string[] };
      raiderIoQuota: {
        spent: Record<string, number>;
        allowance: { mplus: number; mplusArchive: number };
      };
    };

    // Pages failed.
    app.raiderIo.failWith('mythic-plus/runs&page:1', { status: 500, times: 1 });
    await post('/admin/mplus');
    const failed = await getJson<Ready>(app.url(), '/health/ready');
    expect(failed.status).toBe(200);
    expect(failed.body.status).toBe('degraded');
    expect(failed.body.mplus.problems).toEqual(['1 of 5 pages failed on the last pass']);

    // Stopped early.
    const release = holdActive(app.app, 'sweep');
    await post('/admin/mplus');
    await release();
    const stopped = await getJson<Ready>(app.url(), '/health/ready');
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe('degraded');
    expect(stopped.body.mplus.problems).toEqual([
      'the last pass stopped early: live PvP ingestion started',
    ]);

    // The quota block: spend by consumer, and both allowances.
    expect(Object.keys(stopped.body.raiderIoQuota.spent).sort()).toEqual(
      ['mplus', 'mplusArchive', 'other', 'total'].sort(),
    );
    expect(stopped.body.raiderIoQuota.allowance.mplus).toBeGreaterThan(0);
    expect(stopped.body.raiderIoQuota.allowance.mplusArchive).toBeGreaterThan(0);

    // And a clean pass clears it.
    await post('/admin/mplus');
    const clean = await getJson<Ready>(app.url(), '/health/ready');
    expect(clean.body.mplus.problems).toEqual([]);
  });

  it('M12.10 the pass and region lines an operator relies on, and a spent budget without a stack', async () => {
    await post('/admin/mplus');

    expect(
      logger.matching(
        /Mythic\+ pass for season-mn-2 finished in \d+s: 40 runs, \d+ characters across 1 region\(s\)/,
      ),
    ).toHaveLength(1);
    expect(logger.matching(/Mythic\+ us: 40 runs over 5 page\(s\), \d+ characters/)).toHaveLength(
      1,
    );

    // A spent minute is expected, not an error: one warning, no stack.
    logger.clear();
    const realClock = budget.now;
    budget.now = () => Date.now() + 5_000_000;
    budget.record('other', budget.usable);
    await post('/admin/mplus');
    budget.now = realClock;

    const spent = logger.of('warn', /budget for the current minute is spent/);
    expect(spent).toHaveLength(1);
    expect(spent[0].detail).not.toMatch(/\n\s+at /);
    expect(logger.of('error')).toEqual([]);
  });

  it('M12.2 POST /admin/mplus-season re-reads the catalogue and announces what changed', async () => {
    // The next season opens in the US.
    world.seasons.push({
      slug: 'season-mn-3',
      name: 'MN Season 3',
      blizzardSeasonId: 19,
      isMainSeason: true,
      starts: { us: new Date(Date.now() - 60_000).toISOString() },
      ends: { us: '2030-01-01T00:00:00Z' },
      dungeons: 8,
    });

    const response = await post<{
      catalogue: { refreshed: boolean; expansions: number[] };
      seasons: Record<string, { season: string }>;
    }>('/admin/mplus-season');

    // Walked even though the catalogue was fresh, then observed.
    expect(response.body.catalogue).toMatchObject({ refreshed: true, expansions: [11] });
    expect(response.body.seasons.us.season).toBe('season-mn-3');
    expect(
      events.map((event) => [event.kind, event.region, event.previousSeason, event.season]),
    ).toEqual([['rollover', 'us', LIVE, 'season-mn-3']]);
    // M12.10: a rollover is a warning naming both seasons.
    expect(
      logger.of('warn', /Mythic\+ season rollover in us: season-mn-2 replaced by season-mn-3/),
    ).toHaveLength(1);
    expect(
      await db.collection(MPLUS_SEASONS_COLLECTION).countDocuments({ slug: 'season-mn-3' }),
    ).toBe(1);
    await expectInvariants(db);
  });
});
