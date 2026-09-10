import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { World } from './support/world.js';

/**
 * A population the configured share cannot keep up with.
 *
 * Its own file because it needs its own configuration: a headroom so large the
 * enrichment share is a handful of requests an hour. Past that point no budget
 * formula keeps the TTLs — the queue can only fall behind — and the service's
 * job is to say so rather than go quiet.
 */
describe('enrichment that cannot keep its TTLs', () => {
  let harness: TestApp;
  let db: Db;

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us'], players: 200, seed: 22 }), {
      // 36,000 / 6,000 = 6 requests an hour for enrichment.
      QUOTA_ENRICHMENT_HEADROOM: '6000',
      PROFILE_REQUESTS_PER_SECOND: '2000',
    });
    db = harness.app.get(MongoService).db;

    await harness.app.get(LeaderboardService).sweep();
    await harness.app.get(ProfileEnrichmentService).run();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('spends no more than the share, however much is due', async () => {
    const result = await harness.app.get(ProfileEnrichmentService).run();

    // Six requests an hour were all spent by the first run; this one gets none.
    expect(result?.selected).toBe(0);
  });

  it('degrades readiness and names the ceiling, rather than falling behind quietly', async () => {
    const ready = await getJson<{
      status: string;
      enrichment: {
        outlook: { feasible: boolean; bindingConstraint: string; maxSustainablePopulation: number };
        problems: string[];
      };
    }>(await harness.listen(), '/health/ready');

    // Degraded, not down: every stored row is still served, only freshness
    // suffers, and a restart would not change the arithmetic.
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.enrichment.outlook.feasible).toBe(false);
    expect(ready.body.enrichment.outlook.bindingConstraint).toBe('quota share');
    expect(ready.body.enrichment.outlook.maxSustainablePopulation).toBeLessThan(200);
    expect(ready.body.enrichment.problems[0]).toMatch(/Sustainable up to \d+/);
  });
});
