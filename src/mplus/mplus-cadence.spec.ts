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
const defaults = (overrides: Record<string, string> = {}) =>
  validateEnv({
    BLIZZARD_CLIENT_ID: 'id',
    BLIZZARD_CLIENT_SECRET: 'secret',
    MONGODB_URI: 'mongodb://localhost:27017',
    MPLUS_ENABLED: 'true',
    RAIDER_IO_API_KEY: 'key',
    ...overrides,
  });

/** A pass over mocks that end every board on its first page. */
const passWith = (env: Env, coordinator = new IngestionCoordinator()) => {
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  const budget = new RaiderIoBudget(config);
  const regions = new Map(
    env.RAIDERIO_REGIONS.map((region) => [region, { slug: 'season-mn-2', seasonId: 18 }]),
  );
  const getRunsPage = vi.fn(async () => ({ rankings: [] }));
  const service = new MplusService(
    config,
    { getRunsPage } as unknown as MythicPlusApi,
    {
      ensureCatalogue: vi.fn(async () => undefined),
      observe: vi.fn(async () => regions),
    } as unknown as MplusSeasonService,
    {
      upsertAffixes: vi.fn(async () => 0),
      upsertRuns: vi.fn(async () => 0),
      upsertCharacters: vi.fn(async () => ({ written: 0, merged: 0 })),
      countRuns: vi.fn(async () => 0),
      pruneStale: vi.fn(async () => ({ runs: 0, missed: 0, characters: 0 })),
    } as unknown as MplusRepository,
    coordinator,
    budget,
    { recordLive: vi.fn(async () => 0) } as unknown as MplusSpecRepresentationService,
    { recordLive: vi.fn(async () => 0) } as unknown as MplusCutoffsService,
  );

  return { service, budget, coordinator, getRunsPage };
};

/**
 * F1 — M4.1 and M4.4: a full Mythic+ pass against the enrichment cadence.
 *
 * At the checked-in settings a pass is longer than the enrichment interval, so
 * it always meets an enrichment start. It used to stop there and leave every
 * later region for a whole interval; it now pauses for the enrichment pass and
 * resumes where it was (`MPLUS_YIELD_WAIT_MS`), so the arithmetic no longer
 * decides whether a pass completes.
 */
describe('F1: the Mythic+ pass against the enrichment cadence', () => {
  it('M4.1 a full pass is longer than the enrichment interval, so it always spans a start', () => {
    const env = defaults();
    const passMs =
      ((env.RAIDERIO_MAX_PAGES * env.RAIDERIO_REGIONS.length) / env.RAIDERIO_REQUESTS_PER_SECOND) *
      1_000;

    expect(env.RAIDERIO_REGIONS).toHaveLength(5);
    expect(Math.round(passMs / 1_000)).toBe(358);
    expect(env.PROFILE_INTERVAL_MS).toBe(300_000);
    expect(passMs).toBeGreaterThan(env.PROFILE_INTERVAL_MS);
    // Which is why a pass waits for enrichment rather than stopping, and for
    // longer than an enrichment pass takes.
    expect(env.MPLUS_YIELD_WAIT_MS).toBe(600_000);
  });

  it('M4.1 a pass that meets enrichment pauses, resumes, and reads every region', async () => {
    const env = defaults({ RAIDERIO_MAX_PAGES: '10', RAIDERIO_PAGE_BATCH: '5' });
    const coordinator = new IngestionCoordinator();
    const { service, getRunsPage } = passWith(env, coordinator);
    let release!: () => void;
    const enrichment = coordinator.duringEnrichment(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    const pass = service.sweep();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getRunsPage, 'paused before its first region').not.toHaveBeenCalled();
    release();
    await enrichment;
    const result = (await pass)!;

    expect(result.stoppedEarly).toBeNull();
    expect(result.regions.map((region) => region.region)).toEqual(env.RAIDERIO_REGIONS);
    expect(result.pausedMs).toBeGreaterThanOrEqual(50);
  });

  it('M4.1 a pass gives up on the rest only when the wait runs out', async () => {
    const env = defaults({ MPLUS_YIELD_WAIT_MS: '30' });
    const coordinator = new IngestionCoordinator();
    const { service } = passWith(env, coordinator);

    await coordinator.duringEnrichment(async () => {
      const result = (await service.sweep())!;

      expect(result.stoppedEarly).toBe('live PvP ingestion started');
      expect(result.regions).toEqual([]);
      expect(result.pausedMs).toBeGreaterThanOrEqual(25);
    });
  });

  it('M4.4 readiness reports how long the pass paused, and a paused pass is still feasible', async () => {
    const { service, budget } = passWith(defaults());

    await service.sweep();

    const outlook = budget.mplusOutlook!;
    expect(outlook.pagesPlanned).toBe(5_005);
    expect(outlook.pausedMs).toBe(0);
    // Judged against MPLUS_INTERVAL_MS: 5,005 pages at 900 a minute is under
    // six minutes. Enrichment no longer bears on it — the pass waits it out.
    expect(outlook.feasible).toBe(true);
  });
});
