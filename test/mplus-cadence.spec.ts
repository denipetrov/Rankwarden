import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive } from './support/hold.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const INTERVAL_MS = 1_500;
const DEFERRED = /deferring the Mythic\+ pass/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * F1 — M4.3: a scheduled pass that lands while enrichment is running.
 *
 * Its own file, because it needs the real scheduler on a short interval. The
 * tick is skipped rather than queued, so the pass waits for the *next*
 * interval, not for enrichment to end — at production cadence, six hours.
 *
 * Aligned to the scheduler's own tick, read off the log line it writes, so
 * where the tick falls relative to the release is decided rather than raced.
 */
describe('F1: a scheduled Mythic+ pass landing during enrichment', () => {
  let app: TestApp;
  const logger = new CapturingLogger();

  const firstRunAfter = (from: number) =>
    app.raiderIo.requests.find(
      (request) => request.path === 'mythic-plus/runs' && request.at >= from,
    );

  /** Holds enrichment across one scheduled tick, and releases it the moment that tick is skipped. */
  const skipOneTick = async () => {
    logger.clear();
    const release = holdActive(app.app, 'enrichment');
    const heldAt = Date.now();

    while (!logger.matching(DEFERRED).length && Date.now() - heldAt < 3 * INTERVAL_MS)
      await sleep(10);
    const tick = logger.matching(DEFERRED)[0];
    await release();

    return { tick, releasedAt: Date.now() };
  };

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_ENABLED: 'true', MPLUS_INTERVAL_MS: String(INTERVAL_MS) },
      undefined,
      logger,
      new MplusWorld().seed('us', 20, 500),
    );
    // A sweep finishing warms live ingestion up and releases the scheduler.
    await holdActive(app.app, 'sweep')();
    await app.settle();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M4.3 today: the skipped tick makes no request, and the pass waits a whole interval', async () => {
    const { tick, releasedAt } = await skipOneTick();

    expect(tick, 'the scheduler ticked while enrichment ran').toBeDefined();
    expect(firstRunAfter(tick.at - 5), 'nothing at the skipped tick').toBeUndefined();

    // Released straight after the skip: the pass does not follow the release.
    await sleep(INTERVAL_MS / 2);
    expect(firstRunAfter(releasedAt)).toBeUndefined();

    // It comes at the next tick, one interval after the skipped one.
    while (!firstRunAfter(releasedAt) && Date.now() - tick.at < 3 * INTERVAL_MS) await sleep(10);
    const next = firstRunAfter(releasedAt)!;
    expect(next.at - tick.at).toBeGreaterThanOrEqual(INTERVAL_MS - 100);
  });

  // Confirmed 2026-09-25: see the report. Remove `.fails` with the fix.
  it.fails(
    'M4.3 desired: a pass deferred for enrichment is taken once enrichment ends',
    async () => {
      const { releasedAt } = await skipOneTick();
      await sleep(INTERVAL_MS / 2);

      expect(firstRunAfter(releasedAt)).toBeDefined();
    },
  );
});
