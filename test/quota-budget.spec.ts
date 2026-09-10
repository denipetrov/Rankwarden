import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ArchiveService } from '../src/archive/archive.service.js';
import { withRunId } from '../src/common/logging/run-context.js';
import { QuotaBudget } from '../src/common/quota/quota-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { CharacterRepository } from '../src/leaderboard/character.repository.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { ProfileEnrichmentService } from '../src/profile/profile-enrichment.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { World } from './support/world.js';

const DAY = 86_400_000;

/**
 * The shared hourly budget, end to end against a real database.
 *
 * Unit tests prove the arithmetic; this proves the wiring — that every job's
 * requests land on the right account, that enrichment really sizes its batch
 * from what is due, and that the archive really stops when its share is gone.
 */
describe('shared quota budget', () => {
  let harness: TestApp;
  let db: Db;
  let budget: QuotaBudget;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const ladderFetches = () => harness.blizzard.countMatching('/pvp-leaderboard/');
  const profileFetches = () => harness.blizzard.countMatching('profile/wow/character/');

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us'], players: 120, seed: 21 }), {
      PROFILE_REQUESTS_PER_SECOND: '2000',
    });
    db = harness.app.get(MongoService).db;
    budget = harness.app.get(QuotaBudget);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('charges every sweep request to the sweep', async () => {
    harness.blizzard.reset();

    await harness.app.get(LeaderboardService).sweep();

    // The season refresh the sweep triggers is the sweep's too: it happens
    // inside the run, and that is what attribution follows.
    expect(budget.spent('sweep')).toBe(harness.blizzard.requests.length);
    expect(budget.spent('enrichment')).toBe(0);
  });

  it('counts demand over exactly the set selection would pick', async () => {
    // A batch sized from a count of a different set would buy the wrong number
    // of characters, so the two have to agree on real data, not just on paper.
    const repository = harness.app.get(CharacterRepository);
    const summaryStale = new Date(Date.now() - 7 * DAY);
    const specsStale = new Date(Date.now() - DAY);

    const demand = await repository.countEnrichmentDemand(summaryStale, specsStale);
    const selected = await repository.findProfilesToEnrich(summaryStale, specsStale, 1_000_000);

    expect(demand.characters).toBe(selected.length);
    // Never enriched, so both halves are due for every one of them.
    expect(demand.requests).toBe(selected.length * 2);
  });

  it('charges enrichment and spends only what is due', async () => {
    const population = await characters().countDocuments();
    const before = budget.spent('enrichment');

    const result = await harness.app.get(ProfileEnrichmentService).run();

    expect(result?.selected).toBe(population);
    expect(budget.spent('enrichment') - before).toBe(result!.requests);
  });

  it('buys twice the characters when only their specs are due', async () => {
    // Specs age daily and summaries weekly, so most refreshes cost one request.
    // A fixed batch could not tell; a request budget can.
    await characters().updateMany({}, { $set: { specsFetchedAt: new Date(Date.now() - 2 * DAY) } });
    const repository = harness.app.get(CharacterRepository);

    const demand = await repository.countEnrichmentDemand(
      new Date(Date.now() - 7 * DAY),
      new Date(Date.now() - DAY),
    );

    expect(demand.requests).toBe(demand.characters);
  });

  it('fetches nothing once the enrichment share is spent', async () => {
    budget.record('enrichment', budget.allowance('enrichment'));
    const before = profileFetches();

    const result = await harness.app.get(ProfileEnrichmentService).run();

    expect(result?.selected).toBe(0);
    expect(profileFetches(), 'no request once the share is gone').toBe(before);
  });

  it('stops the archive once its share is spent, and leaves the season pending', async () => {
    budget.record('archive', budget.allowance('archive'));
    expect(budget.allowance('archive')).toBe(0);
    const before = ladderFetches();

    const finished = harness.world.season('us').id - 1;
    const result = await withRunId('archive', () =>
      harness.app.get(ArchiveService).archiveSeason(finished, 'us'),
    );

    // Every bracket is pre-empted rather than fetched, which keeps the season
    // pending for the next window rather than marking it done or lost.
    expect(ladderFetches() - before, 'only the bracket list, no ladder').toBe(1);
    expect(result.failedBrackets.length).toBe(result.brackets);
  });

  it('reports the budget and the enrichment outlook on readiness', async () => {
    const baseUrl = await harness.listen();

    const ready = await getJson<{
      status: string;
      quota: { spent: Record<string, number>; allowance: Record<string, number> };
      enrichment: { outlook: { feasible: boolean; population: number }; problems: string[] };
    }>(baseUrl, '/health/ready');

    expect(ready.status).toBe(200);
    expect(ready.body.quota.spent.sweep).toBeGreaterThan(0);
    expect(ready.body.quota.allowance.archive).toBe(0);

    // A small world can keep its TTLs, so the arithmetic is fine...
    expect(ready.body.enrichment.outlook.feasible).toBe(true);
    // ...but an earlier case aged every spec refresh to two days and spent the
    // share before anything could catch up. That is the other signal: not "this
    // can never work" but "this has stopped keeping up", and it is named.
    expect(ready.body.enrichment.problems).toEqual([
      expect.stringMatching(/stalest spec refresh is \d+h old, more than twice its TTL/),
    ]);
    expect(ready.body.status, 'degraded, never down: the data is still served').toBe('degraded');
  });
});
