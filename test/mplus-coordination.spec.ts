import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * Where the Mythic+ pass sits relative to the PvP jobs, what it reports to
 * readiness, and what it does when the season rolls. Retiring the season it
 * rolled away from is the transition's job, in `mplus-season-transition.spec.ts`.
 */
describe('Mythic+ coordination and observability', () => {
  let app: TestApp;
  let mplus: MplusService;
  let coordinator: IngestionCoordinator;
  let db: Db;
  const mplusWorld = new MplusWorld();

  beforeAll(async () => {
    mplusWorld.seed('us', 40, 500);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      { RAIDERIO_REGIONS: 'us' },
      undefined,
      undefined,
      mplusWorld,
    );
    mplus = app.app.get(MplusService);
    coordinator = app.app.get(IngestionCoordinator);
    db = app.app.get(MongoService).db;
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('yields to a PvP sweep rather than competing with it for Mongo', async () => {
    // The request budgets are independent, so this is purely about the database
    // and the process — but it is an explicit ordering, not an accident.
    await coordinator.duringSweep(async () => {
      const result = await mplus.sweep();

      expect(result!.stoppedEarly).toBe('live PvP ingestion started');
      expect(result!.regions).toEqual([]);
    });
  });

  it('yields to profile enrichment too', async () => {
    await coordinator.duringEnrichment(async () => {
      const result = await mplus.sweep();

      expect(result!.stoppedEarly).toBe('live PvP ingestion started');
    });
  });

  it('does not make enrichment or the sweep wait on it', async () => {
    // The archive yields to M+; enrichment must not. Enrichment spends Blizzard
    // quota and M+ spends none, so making enrichment wait would cost the PvP
    // profiles freshness to protect a job it is not competing with.
    await coordinator.duringMplus(async () => {
      expect(coordinator.isMplusActive).toBe(true);
      expect(coordinator.isLiveIngestionActive, 'M+ is not live PvP ingestion').toBe(false);
    });

    expect(coordinator.isMplusActive).toBe(false);
  });

  it('runs when nothing above it is running', async () => {
    const result = await mplus.sweep();

    expect(result!.stoppedEarly).toBeNull();
    expect(result!.runs).toBeGreaterThan(0);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments()).toBeGreaterThan(0);
  });

  it('skips a second pass rather than queueing it', async () => {
    const [first, second] = await Promise.all([mplus.sweep(), mplus.sweep()]);

    // One of the two is refused outright. Two passes over the same leaderboard
    // would race each other's writes and each other's prunes.
    expect([first, second].filter((result) => result === null)).toHaveLength(1);
  });

  it('reports Raider.io and the M+ outlook on readiness, without extra I/O', async () => {
    const ready = await getJson<{
      status: string;
      dependencies: { raiderio: { status: string; regions: Record<string, unknown> } };
      raiderIoQuota: { minuteLimit: number; usable: number; allowance: number };
      mplus: { outlook: { runs: number; feasible: boolean } | null; problems: string[] };
      jobs: { mplusRunning: boolean };
    }>(app.url(), '/health/ready');

    expect(ready.status).toBe(200);
    expect(ready.body.dependencies.raiderio.status).toBe('ok');
    expect(ready.body.dependencies.raiderio.regions.us).toBeDefined();
    expect(ready.body.raiderIoQuota.minuteLimit).toBe(1_000);
    expect(ready.body.raiderIoQuota.usable).toBe(900);
    expect(ready.body.mplus.outlook?.runs).toBeGreaterThan(0);
    expect(ready.body.mplus.problems).toEqual([]);
    expect(ready.body.jobs.mplusRunning).toBe(false);
  });

  it('degrades rather than fails readiness when Raider.io is down', async () => {
    app.raiderIo.failWith('mythic-plus/runs', { status: 503 });
    await mplus.sweep();

    const ready = await getJson<{
      status: string;
      dependencies: { mongo: { status: string }; raiderio: { status: string } };
    }>(app.url(), '/health/ready');

    // 200, not 503. Failing readiness on an upstream outage would have an
    // orchestrator restart-loop the service through an incident it cannot fix.
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.dependencies.mongo.status).toBe('ok');

    app.raiderIo.reset();
  });

  it('never puts the Raider.io key in a health payload', async () => {
    const ready = await getJson<unknown>(app.url(), '/health/ready');

    // The key travels as a query parameter, so it lands inside any url an error
    // message quotes. The endpoint is unauthenticated.
    expect(JSON.stringify(ready.body)).not.toContain('test-raiderio-key');
  });

  it('moves onto a new season when it opens, and leaves the old one for the transition', async () => {
    await mplus.sweep();
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-mn-2' }),
    ).toBeGreaterThan(0);

    // Raider.io publishes a new main season, started after the current one.
    // The start date is what decides, not the order of the list: a season with
    // an earlier start is an older season however it is listed.
    mplusWorld.seasons.push({
      slug: 'season-mn-3',
      name: 'MN Season 3',
      blizzardSeasonId: 19,
      isMainSeason: true,
      starts: { us: '2026-09-01T00:00:00Z' },
      dungeons: 8,
    });
    // The catalogue is fresh, so the pass would not re-read it for a day; the
    // season check would, on its TTL. Refreshed by hand to stand in for that.
    await app.app.get(MplusCatalogueService).refresh();

    const result = await mplus.sweep();
    expect(result!.seasons).toEqual({ us: 'season-mn-3' });

    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-mn-3' }),
    ).toBeGreaterThan(0);

    // The pass no longer deletes the season it rolled away from: that waits for
    // the archive, and is `MplusSeasonTransitionService`'s to do.
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: 'season-mn-2' }),
    ).toBeGreaterThan(0);
    expect(
      await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ season: 'season-mn-2' }),
    ).toBeGreaterThan(0);
  });
});
