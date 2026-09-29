import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService, type MplusSweepResult } from '../src/mplus/mplus.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MPLUS_SEASON_TRANSITIONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from '../src/mplus-season/mplus-season-events.service.js';
import { MplusSeasonTransitionScheduler } from '../src/mplus-season/mplus-season-transition.scheduler.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { MplusSeasonService } from '../src/mplus-season/mplus-season.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { getJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { CapturingLogger, type CapturedLine } from './support/logger.js';
import { MplusWorld, type MplusWorldSeason } from './support/mplus-world.js';
import { World } from './support/world.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PLACEHOLDER_END = '2030-01-01T00:00:00Z';
const OLD = 'season-mn-1';
const CURRENT = 'season-mn-2';
const NEXT = 'season-mn-3';

/**
 * M5.1, M5.2, M5.4, M5.7-M5.10 — the season lifecycle branches
 * `mplus-season-transition.spec.ts` never meets.
 *
 * One story again, in order: a plan read mid-pass; a dry-run purge; a season
 * that has ended everywhere and been archived but has no successor yet; the
 * next season opening in the middle of a pass; the rollover day that follows,
 * with the US on the new season and Europe on the old; and a season ending
 * while the process is down.
 *
 * Dry run on and the interlock off throughout: every purge is planned and
 * recorded, nothing is deleted, and nothing waits on the archive unless a case
 * archives on purpose.
 */
describe('Mythic+ season lifecycle', () => {
  const ENV = {
    RAIDERIO_REGIONS: 'us,eu',
    MPLUS_TRANSITION_ENABLED: 'true',
    MPLUS_PURGE_DRY_RUN: 'true',
    MPLUS_PURGE_REQUIRE_ARCHIVE: 'false',
  };

  const world = new MplusWorld();
  const pvp = World.seed({ regions: ['us'], players: 5 });
  const logger = new CapturingLogger();
  const events: MplusSeasonTransitionEvent[] = [];
  let bootLines: CapturedLine[] = [];
  let app: TestApp;
  let db: Db;

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const refresh = () => app.app.get(MplusCatalogueService).refresh();
  const runsOf = (season: string, region: string) =>
    db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season, region });

  const pass = async (): Promise<MplusSweepResult> => {
    const result = await app.app.get(MplusService).sweep();
    expect(result).not.toBeNull();
    await app.app.get(MplusSeasonTransitionScheduler).whenSettled();

    return result!;
  };

  const boot = async () => {
    app = await bootTestApp(pvp, ENV, undefined, logger, world);
    db = app.app.get(MongoService).db;
    app.app.get(MplusSeasonEvents).transitions$.subscribe((event) => events.push(event));
    await app.listen();
  };

  const current: MplusWorldSeason = {
    slug: CURRENT,
    name: 'MN Season 2',
    blizzardSeasonId: 18,
    isMainSeason: true,
    starts: { us: at(-60 * DAY), eu: at(-60 * DAY + 13 * HOUR) },
    ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
    dungeons: 8,
  };

  beforeAll(async () => {
    world.seasons = [
      current,
      {
        slug: OLD,
        name: 'MN Season 1',
        blizzardSeasonId: 17,
        isMainSeason: true,
        starts: { us: at(-200 * DAY), eu: at(-200 * DAY) },
        ends: { us: at(-61 * DAY), eu: at(-61 * DAY) },
        dungeons: 8,
      },
    ];
    // Unscoped runs: each board serves whichever season it is asked for.
    world.seed('us', 30, 500).seed('eu', 25, 480);

    await boot();
    bootLines = [...logger.lines];
    await refresh();
    await pass();
    app.raiderIo.reset();
    logger.clear();
    events.length = 0;
  });

  afterEach(async () => {
    await releaseAllHolds();
    app.raiderIo.reset();
    logger.clear();
    events.length = 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M5.9 the transition plan on /health/seasons abstains during a pass, and asks nothing', async () => {
    // A leftover of the old season in the US, so the plan has something to name.
    const rows = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .find({ season: CURRENT, region: 'us' }, { projection: { _id: 0 } })
      .limit(3)
      .toArray();
    await db
      .collection(MPLUS_RUNS_COLLECTION)
      .insertMany(rows.map((row) => ({ ...row, season: OLD })));

    const release = holdActive(app.app, 'mplus');
    const during = await getJson<{
      mplus: { transition: { permitted: boolean; reason: string } };
    }>(app.url(), '/health/seasons');
    expect(during.body.mplus.transition).toMatchObject({
      permitted: false,
      reason: 'a Mythic+ pass is running',
    });
    await release();

    const after = await getJson<{
      mplus: {
        seasons: Record<string, { season: string }>;
        transition: {
          permitted: boolean;
          current: Record<string, string | null>;
          candidates: { region: string; season: string }[];
          blockedByArchive: unknown[];
          dryRun: boolean;
          requireArchive: boolean;
        };
      };
    }>(app.url(), '/health/seasons');
    const { transition } = after.body.mplus;
    expect(transition.permitted).toBe(true);
    expect(transition.current).toEqual({ us: CURRENT, eu: CURRENT });
    expect(transition.candidates.map((entry) => [entry.season, entry.region])).toEqual([
      [OLD, 'us'],
    ]);
    expect(transition.blockedByArchive).toEqual([]);
    expect(transition).toMatchObject({ dryRun: true, requireArchive: false });
    expect(transition).toEqual(
      JSON.parse(JSON.stringify(await app.app.get(MplusSeasonTransitionService).plan())),
    );
    expect(after.body.mplus.seasons.us.season).toBe(CURRENT);
    expect(app.raiderIo.requests, 'the endpoint reads the database, not Raider.io').toEqual([]);
  });

  it('M5.4 a dry run counts what it would retire, deletes nothing, and says so', async () => {
    expect(
      bootLines.filter((line) => /dry run: nothing will be deleted/.test(line.message)),
      'the boot log says so too',
    ).toHaveLength(1);
    const stored = await runsOf(OLD, 'us');

    const { purged } = await app.app.get(MplusSeasonTransitionService).run();

    expect(purged).toEqual([
      {
        region: 'us',
        season: OLD,
        dryRun: true,
        removed: { [MPLUS_CHARACTERS_COLLECTION]: 0, [MPLUS_RUNS_COLLECTION]: stored },
      },
    ]);
    expect(await runsOf(OLD, 'us'), 'nothing deleted').toBe(stored);
    expect(
      await db
        .collection(MPLUS_SEASON_TRANSITIONS_COLLECTION)
        .findOne({ season: OLD, region: 'us' }),
    ).toMatchObject({ dryRun: true, triggeredBy: CURRENT });
    expect(
      logger.of('warn', /\[dry run\] Would retire Mythic\+ season season-mn-1 us/),
    ).toHaveLength(1);

    await db.collection(MPLUS_RUNS_COLLECTION).deleteMany({ season: OLD });
  });

  it('M5.8 ended everywhere and archived, with no successor: still live, figures left alone', async () => {
    // The season ends in both regions, Raider.io lists nothing after it yet,
    // and the archive takes it.
    current.ends = { us: at(-HOUR), eu: at(-HOUR) };
    await refresh();
    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    // The older finished season is archived in the same tick, as it should be.
    expect(tick!.seasons.map((season) => [season.season, season.outcome])).toContainEqual([
      CURRENT,
      'complete',
    ]);
    const figures = await db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .find({ season: CURRENT }, { projection: { _id: 0 } })
      .sort({ region: 1, dungeonId: 1 })
      .toArray();
    expect(figures.every((doc) => doc.source === 'archive')).toBe(true);
    app.raiderIo.reset();

    const refreshedBefore = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .findOne({ season: CURRENT, region: 'us' });
    const result = await pass();

    // Still the current season, so the pass keeps its board fresh.
    expect(result.seasons).toEqual({ us: CURRENT, eu: CURRENT });
    expect(result.stoppedEarly).toBeNull();
    const refreshedAfter = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .findOne({ season: CURRENT, region: 'us', keystoneRunId: refreshedBefore!.keystoneRunId });
    expect(refreshedAfter!.fetchedAt.getTime()).toBeGreaterThan(
      refreshedBefore!.fetchedAt.getTime(),
    );
    // But the figures are the archive's now (R5), and so are the cutoffs.
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .find({ season: CURRENT }, { projection: { _id: 0 } })
        .sort({ region: 1, dungeonId: 1 })
        .toArray(),
    ).toEqual(figures);
    expect(app.raiderIo.countMatching('season-cutoffs')).toBe(0);
    // And nothing has superseded it.
    const { plan, purged } = await app.app.get(MplusSeasonTransitionService).run();
    expect(plan.candidates).toEqual([]);
    expect(purged).toEqual([]);
  });

  it('M5.1 a season opening during a pass is picked up by the next one, not this one', async () => {
    let opened: Promise<unknown> | null = null;

    app.raiderIo.beforeServe = (request) => {
      if (opened || request.path !== 'mythic-plus/runs' || request.region !== 'eu') return;
      if (request.page !== 1) return;

      world.seasons.push({
        slug: NEXT,
        name: 'MN Season 3',
        blizzardSeasonId: 19,
        isMainSeason: true,
        starts: { us: at(-60_000), eu: at(DAY) },
        ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
        dungeons: 8,
      });
      opened = refresh();
    };

    const result = await pass();
    await opened;

    // Regions are resolved once, before page 0.
    expect(opened).not.toBeNull();
    expect(result.seasons).toEqual({ us: CURRENT, eu: CURRENT });
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: NEXT })).toBe(0);
    expect(
      app.raiderIo.requests.filter((request) => request.season === NEXT),
      'nothing was asked of the new season',
    ).toEqual([]);
  });

  it('M5.2 M5.7 rollover day: two regions, two seasons, one pass, and the tick after it', async () => {
    // Long enough that the rollover tick, started by this pass's own
    // observation, is certainly waiting for the pass rather than racing it.
    app.raiderIo.delayMs = 20;

    const result = await pass();
    const lastRequestAt = Math.max(...app.raiderIo.requests.map((request) => request.at));

    // M5.7: each region on its own season, filed under it, and nowhere else.
    expect(result.seasons).toEqual({ us: NEXT, eu: CURRENT });
    expect(events.map((event) => [event.kind, event.region, event.season])).toEqual([
      ['rollover', 'us', NEXT],
    ]);
    const runRequests = app.raiderIo.requests.filter(
      (request) => request.path === 'mythic-plus/runs',
    );
    expect(new Set(runRequests.map((request) => `${request.region}:${request.season}`))).toEqual(
      new Set([`us:${NEXT}`, `eu:${CURRENT}`]),
    );
    expect(await runsOf(NEXT, 'us')).toBe(30);
    expect(await runsOf(NEXT, 'eu')).toBe(0);
    // The US's old board is untouched by the US's prune, which is scoped to the
    // season it read; retiring it is the transition's to do.
    expect(await runsOf(CURRENT, 'us')).toBe(30);
    expect(await runsOf(CURRENT, 'eu')).toBe(25);

    // Representation recorded for both seasons read (the old one is the
    // archive's, so that half is left as it is).
    expect(
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .distinct('region', { season: NEXT }),
    ).toEqual(['all', 'us']);

    // Cutoffs per region for its own season (M8.6 in full is in
    // mplus-season-resolution.spec.ts, where neither season is archived).
    const cutoffs = app.raiderIo.requests
      .filter((request) => request.path === 'mythic-plus/season-cutoffs')
      .map((request) => `${request.region}:${request.season}`);
    // Europe's season is archived everywhere, so its cutoffs are final and not
    // asked again; the US is asked for the season it is now on.
    expect(cutoffs).toEqual([`us:${NEXT}`]);

    // M5.2: the tick the rollover started waited for the pass, then ran.
    const purge = await db
      .collection(MPLUS_SEASON_TRANSITIONS_COLLECTION)
      .findOne({ season: CURRENT, region: 'us' });
    expect(purge, 'recorded, not skipped because a pass was running').not.toBeNull();
    expect(purge!.purgedAt.getTime()).toBeGreaterThanOrEqual(lastRequestAt);
    expect(purge).toMatchObject({ triggeredBy: NEXT, dryRun: true });
    expect(logger.matching(/purge not permitted/)).toEqual([]);

    await expectInvariants(db);
  });

  it('M5.10 a season that ended while the process was down is announced as ended at boot', async () => {
    // The US is on the new season, not ended. It ends while nobody is looking.
    await app.close();
    world.seasons.find((season) => season.slug === NEXT)!.ends = {
      us: at(-HOUR),
      eu: PLACEHOLDER_END,
    };
    await boot();
    await refresh();

    await app.app.get(MplusSeasonService).observe();
    expect(
      events.map((event) => [event.kind, event.region, event.season, event.acrossRestart]),
    ).toEqual([['ended', 'us', NEXT, true]]);

    events.length = 0;
    await app.app.get(MplusSeasonService).observe();
    expect(events, 'said once, not on every observation').toEqual([]);
  });
});
