import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { CapturingLogger } from './support/logger.js';
import { World } from './support/world.js';
import { GUILDS_COLLECTION, RAIDS_COLLECTION } from '../src/database/collections.js';

/**
 * Raid plan R7.7 — with both raid jobs switched off, which is how every
 * deployment that predates them runs, nothing raid-related is asked for or
 * written, at boot or once the other jobs have warmed up.
 */
describe('Raid jobs switched off', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    app = await bootTestApp(World.seed({ regions: ['us'], players: 5 }), {}, undefined, logger);
    db = app.app.get(MongoService).db;
    await app.settle();
    // The event that would start the rankings, were they on.
    await app.app.get(LeaderboardService).sweep();
    await app.settle();
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('R7.7 asks Raider.io nothing about raids, and stores no raid and no guild', async () => {
    expect(app.raiderIo.requests.filter((request) => request.path.startsWith('raiding/'))).toEqual(
      [],
    );
    expect(await db.collection(RAIDS_COLLECTION).countDocuments()).toBe(0);
    expect(await db.collection(GUILDS_COLLECTION).countDocuments()).toBe(0);
    expect(logger.matching(/^Raid catalogue disabled$/)).toHaveLength(1);
    expect(logger.matching(/^Raid rankings disabled$/)).toHaveLength(1);
  });

  it('R7.7 reports both jobs as never run, and does not hold them against readiness', async () => {
    const health = await getJson<{ jobs: Record<string, unknown> }>(app.url(), '/health');
    expect(health.body.jobs).toMatchObject({
      raidCatalogue: { running: false, lastWalk: null },
      raidRankingsRunning: false,
      raidRankings: null,
    });

    const ready = await getJson<{
      status: string;
      dependencies: { raiderioRankings: { status: string; failingRegions: string[] } };
    }>(app.url(), '/health/ready');
    expect(ready.body.dependencies.raiderioRankings).toMatchObject({
      status: 'unknown',
      failingRegions: [],
    });
    expect(ready.body.status).toBe('ok');
  });
});
