import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive } from './support/hold.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const INTERVAL_MS = 1_500;
const WAITING = /the Mythic\+ pass waits for it/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * F1 — M4.3: a scheduled pass that lands while enrichment is running.
 *
 * Its own file, because it needs the real scheduler on a short interval. The
 * tick used to be skipped, so the pass came back only at the next interval —
 * six hours at the defaults, and an interval that kept landing on enrichment
 * kept losing its pass. It now waits for enrichment (`MPLUS_YIELD_WAIT_MS`) and
 * runs as soon as it ends.
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

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us',
        MPLUS_ENABLED: 'true',
        MPLUS_INTERVAL_MS: String(INTERVAL_MS),
        MPLUS_YIELD_WAIT_MS: '5000',
      },
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

  it('M4.3 a tick during enrichment waits for it, and the pass follows the release at once', async () => {
    logger.clear();
    const release = holdActive(app.app, 'enrichment');
    const heldAt = Date.now();

    while (!logger.matching(WAITING).length && Date.now() - heldAt < 3 * INTERVAL_MS) {
      await sleep(10);
    }
    const tick = logger.matching(WAITING)[0];
    expect(tick, 'the scheduler ticked while enrichment ran').toBeDefined();
    expect(firstRunAfter(tick.at - 5), 'nothing while enrichment runs').toBeUndefined();

    await sleep(100);
    await release();
    const releasedAt = Date.now();

    while (!firstRunAfter(releasedAt) && Date.now() - releasedAt < INTERVAL_MS) await sleep(5);
    const next = firstRunAfter(releasedAt);
    expect(next, 'the waiting pass ran').toBeDefined();
    // Straight after the release, not at the next interval.
    expect(next!.at - releasedAt).toBeLessThan(INTERVAL_MS / 3);
    expect(logger.matching(/deferring the Mythic\+ pass/)).toEqual([]);
  });
});
