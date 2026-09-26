import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { RaiderIoBudget } from '../common/quota/raiderio-budget.service.js';
import { validateEnv, type Env } from '../config/env.schema.js';
import type { MplusSpecRepresentationService } from '../mplus-representation/mplus-spec-representation.service.js';
import type { MplusCutoffsService } from '../mplus-season/mplus-cutoffs.service.js';
import type { MplusSeasonService } from '../mplus-season/mplus-season.service.js';
import type { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import type { MplusRepository } from './mplus.repository.js';
import { MplusService } from './mplus.service.js';

/** The checked-in defaults, with the live pass switched on as `.env` has it. */
const defaults = () =>
  validateEnv({
    BLIZZARD_CLIENT_ID: 'id',
    BLIZZARD_CLIENT_SECRET: 'secret',
    MONGODB_URI: 'mongodb://localhost:27017',
    MPLUS_ENABLED: 'true',
    RAIDER_IO_API_KEY: 'key',
  });

/**
 * F1 — M4.1 and M4.4: whether a full Mythic+ pass fits between two
 * enrichment starts at the checked-in settings, and whether readiness says so.
 *
 * A pass yields to enrichment at every batch boundary and does not resume; the
 * regions after the yield wait for the next interval. So a pass that cannot
 * finish between two enrichment starts is one that, whenever enrichment has
 * work, leaves its trailing regions for six hours.
 *
 * The desired behaviour is asserted in `it.fails` cases: each fails today, which
 * is the finding, and will start "passing" — and so fail the suite — the moment
 * a fix makes it true. Remove `.fails` with the fix.
 */
describe('F1: the Mythic+ pass against the enrichment cadence', () => {
  it('M4.1 today: a full pass is longer than the enrichment interval, so it always spans a start', () => {
    const env = defaults();
    const passMs =
      ((env.RAIDERIO_MAX_PAGES * env.RAIDERIO_REGIONS.length) / env.RAIDERIO_REQUESTS_PER_SECOND) *
      1_000;

    expect(env.RAIDERIO_REGIONS).toHaveLength(5);
    expect(Math.round(passMs / 1_000)).toBe(358);
    expect(env.PROFILE_INTERVAL_MS).toBe(300_000);
    expect(passMs).toBeGreaterThan(env.PROFILE_INTERVAL_MS);

    // And it is checked often: once before every batch, in every region.
    const checks =
      Math.ceil(env.RAIDERIO_MAX_PAGES / env.RAIDERIO_PAGE_BATCH) * env.RAIDERIO_REGIONS.length;
    expect(checks).toBe(105);
  });

  // Confirmed 2026-09-25: 358s of pass against a 300s interval, before any
  // time is allowed for the enrichment pass itself.
  it.fails('M4.1 desired: a full pass fits between two enrichment starts', () => {
    const env = defaults();
    const passMs =
      ((env.RAIDERIO_MAX_PAGES * env.RAIDERIO_REGIONS.length) / env.RAIDERIO_REQUESTS_PER_SECOND) *
      1_000;
    // The most generous reading: an enrichment pass that takes no time at all.
    const gapMs = env.PROFILE_INTERVAL_MS;

    expect(passMs).toBeLessThanOrEqual(gapMs);
  });

  /** A pass over mocks that end every board on its first page, at the default settings. */
  const passAtDefaults = async () => {
    const env = defaults();
    const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
    const budget = new RaiderIoBudget(config);
    const regions = new Map(
      env.RAIDERIO_REGIONS.map((region) => [region, { slug: 'season-mn-2', seasonId: 18 }]),
    );
    const service = new MplusService(
      config,
      { getRunsPage: vi.fn(async () => ({ rankings: [] })) } as unknown as MythicPlusApi,
      {
        ensureCatalogue: vi.fn(async () => undefined),
        observe: vi.fn(async () => regions),
      } as unknown as MplusSeasonService,
      {
        upsertAffixes: vi.fn(async () => 0),
        upsertRuns: vi.fn(async () => 0),
        upsertCharacters: vi.fn(async () => ({ written: 0, merged: 0 })),
        pruneStale: vi.fn(async () => ({ runs: 0, characters: 0 })),
      } as unknown as MplusRepository,
      new IngestionCoordinator(),
      budget,
      { recordLive: vi.fn(async () => 0) } as unknown as MplusSpecRepresentationService,
      { recordLive: vi.fn(async () => 0) } as unknown as MplusCutoffsService,
    );

    await service.sweep();

    return { env, outlook: budget.mplusOutlook! };
  };

  it('M4.4 today: readiness calls the checked-in cadence feasible', async () => {
    const { env, outlook } = await passAtDefaults();
    const passMs = (outlook.pagesPlanned / env.RAIDERIO_REQUESTS_PER_SECOND) * 1_000;

    // Enrichment is on, and the pass is longer than its interval...
    expect(env.PROFILE_ENRICHMENT_ENABLED).toBe(true);
    expect(passMs).toBeGreaterThan(env.PROFILE_INTERVAL_MS);
    // ...but feasibility is judged against MPLUS_INTERVAL_MS alone: 5,005 pages
    // at 900 a minute is under six minutes, well inside six hours.
    expect(outlook.pagesPlanned).toBe(5_005);
    expect(outlook.feasible).toBe(true);
  });

  // Confirmed 2026-09-25: `feasible` never looks at PROFILE_INTERVAL_MS, so a
  // cadence that cannot complete while enrichment runs reads as achievable.
  it.fails(
    'M4.4 desired: a pass longer than the enrichment interval is not called feasible',
    async () => {
      // One assertion, so `.fails` cannot be satisfied by anything but it: the
      // preconditions are the "today" case's.
      const { outlook } = await passAtDefaults();

      expect(outlook.feasible).toBe(false);
    },
  );
});
