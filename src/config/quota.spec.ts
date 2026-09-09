import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema.js';

/** SKILLS.md §"Blizzard Game Data API": 100 requests/second, 36,000/hour. */
const HOURLY_QUOTA = 36_000;
/** Ladder fetches in one sweep: 83 ingestable brackets across four regions. */
const SWEEP_REQUESTS = 83 * 4;

const base = {
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  MONGODB_URI: 'mongodb://localhost:27017',
};

/**
 * Independent verification of `74bdf7c` — the arithmetic, not the wiring.
 *
 * The retry split exists for one reason: at the checked-in defaults, retrying
 * every profile fetch three times puts enrichment alone over the hourly quota.
 * That reasoning lives in a commit message and a paragraph of SKILLS.md, and
 * both stop being true the moment somebody raises `PROFILE_BATCH_SIZE` or drops
 * `PROFILE_INTERVAL_MS` — silently, because nothing recomputes it.
 *
 * The wiring is covered in `test/blizzard-http.spec.ts`, which counts actual
 * attempts against a real listener. This is the other half: the numbers those
 * attempts are chosen from.
 */
describe('request budget at the checked-in defaults', () => {
  const env = validateEnv({ ...base });

  /** Two halves per character, every interval, for a full hour. */
  const enrichmentPerHour = (retryLimit: number) => {
    const passesPerHour = 3_600_000 / env.PROFILE_INTERVAL_MS;
    const attemptsPerRequest = retryLimit + 1;

    return env.PROFILE_BATCH_SIZE * 2 * passesPerHour * attemptsPerRequest;
  };

  it('spends 12,000 requests an hour on enrichment before a single retry', () => {
    // The figure the whole argument rests on. 500 characters x 2 halves every
    // 5 minutes is a third of the quota with nothing going wrong.
    expect(enrichmentPerHour(0)).toBe(12_000);
    expect(enrichmentPerHour(0)).toBeLessThan(HOURLY_QUOTA / 2);
  });

  it('would blow the whole quota on enrichment alone at the shared retry limit', () => {
    // This is the case the split exists to prevent. If this assertion ever
    // starts failing, the split has stopped being necessary and should be
    // reconsidered rather than kept out of habit.
    expect(enrichmentPerHour(env.BLIZZARD_RETRY_LIMIT)).toBe(48_000);
    expect(enrichmentPerHour(env.BLIZZARD_RETRY_LIMIT)).toBeGreaterThan(HOURLY_QUOTA);
  });

  it('stays inside the quota at the profile retry limit, with room for the sweep', () => {
    const worstCase = enrichmentPerHour(env.PROFILE_RETRY_LIMIT);
    const sweepWorstCase = SWEEP_REQUESTS * (env.BLIZZARD_RETRY_LIMIT + 1);

    expect(worstCase).toBe(24_000);
    expect(
      worstCase + sweepWorstCase,
      'enrichment and a fully failing sweep still fit inside the hour',
    ).toBeLessThan(HOURLY_QUOTA);
  });

  it('leaves the sweep the larger retry budget, because it is the cheaper one', () => {
    // A ladder fetch is worth several attempts precisely because there are only
    // a few hundred of them; a character is not.
    expect(env.PROFILE_RETRY_LIMIT).toBeLessThan(env.BLIZZARD_RETRY_LIMIT);
    expect(
      SWEEP_REQUESTS * (env.BLIZZARD_RETRY_LIMIT + 1),
      'even a sweep where every bracket exhausts its retries is a fraction of the hour',
    ).toBeLessThan(HOURLY_QUOTA / 4);
  });

  it('holds for a deployment that runs enrichment twice as often', () => {
    // The nearest plausible tuning, and the one that would quietly break this.
    const doubled = validateEnv({ ...base, PROFILE_INTERVAL_MS: '150000' });
    const perHour =
      doubled.PROFILE_BATCH_SIZE *
      2 *
      (3_600_000 / doubled.PROFILE_INTERVAL_MS) *
      (doubled.PROFILE_RETRY_LIMIT + 1);

    expect(perHour, 'still inside the quota, but with nothing to spare').toBe(48_000);
    expect(
      perHour,
      'so halving the interval is a quota decision, not a throughput one',
    ).toBeGreaterThan(HOURLY_QUOTA);
  });
});
