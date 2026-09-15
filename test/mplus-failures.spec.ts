import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusRepository } from '../src/mplus/mplus.repository.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * What happens when a Mythic+ pass does not go cleanly.
 *
 * Its own file because the harness locks one configuration per file, and these
 * need a small budget and a deep page ceiling that the happy path does not.
 */
describe('Mythic+ failure modes', () => {
  let app: TestApp;
  let mplus: MplusService;
  let budget: RaiderIoBudget;
  let db: Db;
  let clockOffset = 0;
  const mplusWorld = new MplusWorld();

  beforeAll(async () => {
    mplusWorld.seed('us', 200, 500);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        RAIDERIO_REGIONS: 'us',
        RAIDERIO_MAX_PAGES: '10',
        RAIDERIO_PAGE_BATCH: '2',
        RAIDERIO_MINUTE_LIMIT: '1000',
        RAIDERIO_UTILISATION: '0.9',
      },
      undefined,
      undefined,
      mplusWorld,
    );
    mplus = app.app.get(MplusService);
    budget = app.app.get(RaiderIoBudget);
    budget.now = () => Date.now() + clockOffset;
    db = app.app.get(MongoService).db;
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * The budget's window is a rolling minute, so spend from one test is still
   * counted in the next. Advancing a shared clock past the window between tests
   * isolates them without a reset method the production code has no use for.
   */
  beforeEach(() => {
    app.raiderIo.reset();
    clockOffset += 120_000;
  });

  it('plans against the utilisation margin, not the raw minute limit', () => {
    expect(budget.minuteLimit).toBe(1_000);
    expect(budget.usable).toBe(900);
  });

  it('charges every request to the Raider.io budget, not to the Blizzard one', async () => {
    const before = budget.spent('mplus');

    await mplus.sweep();

    expect(budget.spent('mplus')).toBeGreaterThan(before);
    // The Blizzard budget models a different upstream's cap entirely. Charging
    // Raider.io requests to it would throttle enrichment and the archive for no
    // reason and make readiness misreport both.
    const { QuotaBudget } = await import('../src/common/quota/quota-budget.service.js');
    const blizzard = app.app.get(QuotaBudget);
    expect(blizzard.spent('enrichment')).toBe(0);
    expect(blizzard.spent('archive')).toBe(0);
  });

  it('stops when the minute budget is spent rather than pushing through it', async () => {
    // Spent deliberately rather than by configuring a tiny ceiling, so the
    // exhausted-budget branch is reached without the ceiling leaking into
    // every other case in the file.
    budget.record('mplus', budget.usable);

    const result = await mplus.sweep();

    expect(result!.regions[0].stoppedEarly).toBe('Raider.io budget spent');
    expect(result!.regions[0].pagesFetched).toBe(0);
  });

  it('skips the prune when a pass stopped early, so it cannot empty the board', async () => {
    const storedBefore = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments();
    expect(storedBefore, 'earlier passes stored something').toBeGreaterThan(0);

    budget.record('mplus', budget.usable);
    const result = await mplus.sweep();

    expect(result!.regions[0].stoppedEarly).not.toBeNull();
    expect(result!.regions[0].prunedRuns, 'a partial pass prunes nothing').toBe(0);
    expect(
      await db.collection(MPLUS_RUNS_COLLECTION).countDocuments(),
      'nothing already stored was removed',
    ).toBe(storedBefore);
  });

  it('records the outage on Raider.io health without failing the pass', async () => {
    app.raiderIo.failWith('mythic-plus/runs', { status: 503 });

    const { DependencyHealth } = await import('../src/common/health/dependency-health.service.js');
    const health = app.app.get(DependencyHealth);

    // The pass reports the shortfall; it does not throw. A failing upstream
    // degrades ingestion, it does not take the process down.
    await expect(mplus.sweep()).resolves.not.toBeNull();

    expect(health.statusFor('raiderio')).not.toBe('ok');
    expect(health.failingRegionsFor('raiderio')).toContain('us');
    // Blizzard's own health is untouched: one upstream failing must never be
    // reported as the other failing.
    expect(health.blizzardStatus()).not.toBe('down');
  });

  it('forgets a Raider.io outage the moment real traffic succeeds again', async () => {
    const { DependencyHealth } = await import('../src/common/health/dependency-health.service.js');
    const health = app.app.get(DependencyHealth);

    app.raiderIo.failWith('mythic-plus/runs', { status: 503, times: 2 });
    await mplus.sweep();

    // A couple of failed pages inside an otherwise healthy pass is noise, not
    // an outage: the later successes reset the streak. Only an unbroken run of
    // failures reports as down.
    expect(health.statusFor('raiderio')).toBe('ok');
    expect(health.byRegion('raiderio').us.lastError, 'but the failure is remembered').toContain(
      '503',
    );
  });

  it('leaves a stored character untouched when its region cannot be refetched', async () => {
    const before = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ region: 'us', nameKey: 'regular' });
    expect(before, 'the happy-path passes stored it').not.toBeNull();

    app.raiderIo.failWith('mythic-plus/runs', { status: 500 });
    await mplus.sweep();

    const after = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ region: 'us', nameKey: 'regular' });

    // Stale but real beats nothing, the same trade profile enrichment makes.
    expect(after).not.toBeNull();
    expect(after!.mythicScore).toBe(before!.mythicScore);
  });

  it('refuses to remove characters for a region whose runs are all gone', async () => {
    // The guard that stops one failed region from being wiped, asserted at the
    // repository rather than through the service: the service-level check is
    // the first line, this is the one that holds if a future caller skips it.
    // Same reasoning as `removeRetiredBrackets` refusing an empty bracket list.
    const repository = app.app.get(MplusRepository);
    const stored = await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments();
    expect(stored, 'there are characters to lose').toBeGreaterThan(0);

    await db.collection(MPLUS_RUNS_COLLECTION).deleteMany({ season: 'season-mn-2', region: 'us' });

    const removed = await repository.removeCharactersWithoutRuns('season-mn-2', 'us');

    expect(removed, 'no runs means the pass failed, not that the ladder emptied').toBe(0);
    expect(await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments()).toBe(stored);

    // Put the board back for the cases after this one.
    await mplus.sweep();
  });

  it('treats an empty 2xx body as a transient failure, not as payload drift', async () => {
    app.raiderIo.failWith('mythic-plus/runs', { empty: true, times: 1 });

    const result = await mplus.sweep();

    // Counted as a failed page and no prune, rather than parsed as an empty
    // leaderboard and acted on. Raider.io sits behind Cloudflare, which answers
    // exactly this way while shedding load.
    expect(result!.regions[0].pagesFailed).toBeGreaterThan(0);
    expect(result!.regions[0].prunedRuns).toBe(0);
  });
});
