import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { HOUR_MS, QuotaBudget } from '../common/quota/quota-budget.service.js';
import { projectCapacity } from '../profile/enrichment-capacity.js';
import { validateEnv, type Env } from './env.schema.js';

/** SKILLS.md §6: 100 requests/second, 36,000/hour. */
const HOURLY_QUOTA = 36_000;
/** Ladder fetches in one sweep: 83 ingestable brackets across four regions. */
const SWEEP_REQUESTS = 83 * 4;
/** The live population when the shared budget was introduced. */
const POPULATION = 143_203;

const base = {
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  MONGODB_URI: 'mongodb://localhost:27017',
};

const budgetFor = (env: Env) =>
  new QuotaBudget({ get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>);

/** What one run may plan, exactly as `ProfileEnrichmentService.planBatch` works it out. */
const perRunCeiling = (env: Env, budget: QuotaBudget) =>
  Math.ceil((budget.enrichmentShare * env.PROFILE_INTERVAL_MS) / HOUR_MS) * 2;

/**
 * The quota arithmetic at the checked-in defaults.
 *
 * This file used to derive enrichment's spend as `PROFILE_BATCH_SIZE x 2 x
 * passes an hour`, because under a fixed batch that was the spend — and it
 * warned, correctly, that the figure stopped being true the moment somebody
 * raised the batch or shortened the interval, because nothing recomputed it.
 *
 * The shared budget is that recomputation. Enrichment now plans from a share
 * of the hour, so its spend no longer follows either knob; the assertions below
 * are what that buys, measured through the real budget rather than a restated
 * formula.
 */
describe('request budget at the checked-in defaults', () => {
  const env = validateEnv({ ...base });
  const budget = budgetFor(env);

  it('gives enrichment a third of the hour — 12,000 requests', () => {
    // The headroom the user asked for: planned enrichment is at most a third of
    // the cap, which also covers the doubling a single profile retry allows.
    expect(env.QUOTA_HOURLY_LIMIT).toBe(HOURLY_QUOTA);
    expect(budget.enrichmentShare).toBe(12_000);
    expect(budget.enrichmentShare * (env.PROFILE_RETRY_LIMIT + 1)).toBeLessThanOrEqual(
      HOURLY_QUOTA * (2 / 3),
    );
  });

  it('paces that share evenly across the runs of an hour', () => {
    const runsPerHour = HOUR_MS / env.PROFILE_INTERVAL_MS;
    const evenShare = Math.ceil((budget.enrichmentShare * env.PROFILE_INTERVAL_MS) / HOUR_MS);

    expect(evenShare * runsPerHour).toBeGreaterThanOrEqual(budget.enrichmentShare);
    // One run may catch up on a skipped one, never drain the hour in a burst.
    expect(perRunCeiling(env, budget)).toBeLessThan(budget.enrichmentShare / 4);
  });

  it('no longer lets the batch size or interval set the hourly spend', () => {
    // The case this file used to warn about. Doubling the batch or halving the
    // interval used to double the hourly spend and, with retries, break the
    // quota. Now both only change pacing: the hourly ceiling is the share.
    for (const overrides of [
      { PROFILE_BATCH_SIZE: '8000' },
      { PROFILE_INTERVAL_MS: '150000' },
      { PROFILE_BATCH_SIZE: '8000', PROFILE_INTERVAL_MS: '60000' },
    ]) {
      const tuned = validateEnv({ ...base, ...overrides });
      const tunedBudget = budgetFor(tuned);

      expect(tunedBudget.enrichmentShare, JSON.stringify(overrides)).toBe(12_000);
      expect(tunedBudget.allowance('enrichment'), JSON.stringify(overrides)).toBe(12_000);
    }
  });

  it('keeps every promised share inside what is usable', () => {
    // The sweep reserve and enrichment share are promises; the archive gets the
    // remainder. If they did not fit, the archive's allowance would be negative
    // from the first request.
    expect(budget.sweepReserve + budget.enrichmentShare).toBeLessThanOrEqual(budget.usable);
    expect(budget.allowance('archive')).toBe(
      budget.usable - budget.sweepReserve - budget.enrichmentShare,
    );
    expect(budget.allowance('archive')).toBeGreaterThan(0);
  });

  it('holds back more than a normal sweep, and its retries fit in the margin', () => {
    // A sweep is never throttled. The reserve covers a normal one several times
    // over; a sweep where every bracket exhausts its retries overflows the
    // reserve, and the utilisation margin is what absorbs that overflow.
    const sweepWorstCase = SWEEP_REQUESTS * (env.BLIZZARD_RETRY_LIMIT + 1);

    expect(budget.sweepReserve).toBeGreaterThan(SWEEP_REQUESTS * 2);
    expect(sweepWorstCase - budget.sweepReserve).toBeLessThan(HOURLY_QUOTA - budget.usable);
  });

  it('leaves the sweep the larger retry budget, because it is the cheaper one', () => {
    // A ladder fetch is worth several attempts precisely because there are only
    // a few hundred of them; a character is not.
    expect(env.PROFILE_RETRY_LIMIT).toBeLessThan(env.BLIZZARD_RETRY_LIMIT);
    expect(SWEEP_REQUESTS * (env.BLIZZARD_RETRY_LIMIT + 1)).toBeLessThan(HOURLY_QUOTA / 4);
  });
});

describe('enrichment capacity at the checked-in defaults', () => {
  const env = validateEnv({ ...base });
  const budget = budgetFor(env);
  const project = (overrides: Partial<Parameters<typeof projectCapacity>[0]> = {}) =>
    projectCapacity({
      population: POPULATION,
      specsTtlMs: env.PROFILE_SPECS_TTL_MS,
      summaryTtlMs: env.PROFILE_SUMMARY_TTL_MS,
      enrichmentShare: budget.enrichmentShare,
      batchSize: env.PROFILE_BATCH_SIZE,
      intervalMs: env.PROFILE_INTERVAL_MS,
      oldestRefreshAgeMs: null,
      ...overrides,
    });

  it('keeps every TTL for the population it was measured at', () => {
    const outlook = project();

    // 143,203 x (1/24 + 1/168) ≈ 6,800 an hour against a 12,000 share.
    expect(outlook.demandPerHour).toBe(6_819);
    expect(outlook.feasible).toBe(true);
    expect(outlook.bindingConstraint).toBe('quota share');
  });

  it('would have been right at the edge under the old fixed batch of 500', () => {
    // Why PROFILE_BATCH_SIZE moved to 2,000: at 500 the batch, not the quota,
    // was the binding limit, and it capped the population at almost exactly
    // the one in the database — a handful of new characters from falling
    // behind, with nothing reporting it.
    const old = project({ batchSize: 500 });

    expect(old.bindingConstraint).toBe('batch size');
    expect(old.maxSustainablePopulation).toBeLessThan(POPULATION * 1.01);
    expect(old.maxSustainablePopulation).toBeGreaterThanOrEqual(POPULATION);
  });

  it('names the population past which no budget can keep the TTLs', () => {
    const outlook = project();

    // 12,000 / (1/24 + 1/168): the ceiling a third of the quota buys.
    expect(outlook.maxSustainablePopulation).toBe(252_000);
    expect(project({ population: 260_000 }).feasible).toBe(false);
  });
});
