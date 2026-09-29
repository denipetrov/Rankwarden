import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ArchiveService } from '../src/archive/archive.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The PvP archive against the sweep, on equal intervals (both an hour at the
 * defaults), with the real schedulers. The same phase lock as
 * `scheduler-phase-lock-mplus.spec.ts`: every archive tick landed on a sweep
 * start and skipped, so only the warm-up tick ever archived anything — and a
 * season that finished while the process ran was never archived until a
 * restart, holding the season transition's interlock shut.
 */
describe('PvP archive ticks on the same interval as the sweep', () => {
  let app: TestApp;
  /** Distinct ticks that reached the backlog: each passes its own `failedThisTick`. */
  const ticks = new Set<unknown>();

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        INGEST_INTERVAL_MS: String(INTERVAL_MS),
        ARCHIVE_ENABLED: 'true',
        ARCHIVE_CHECK_INTERVAL_MS: String(INTERVAL_MS),
        ARCHIVE_WAIT_FOR_IDLE_MS: '5000',
        // Nothing owed, so each tick is one quick look at the backlog and the
        // ticks can be counted; a backlog would keep one tick busy throughout.
        ARCHIVE_MIN_SEASON: '42',
      },
      undefined,
      undefined,
      new MplusWorld(),
    );
    const archive = app.app.get(ArchiveService);
    const real = archive.nextPending.bind(archive);
    vi.spyOn(archive, 'nextPending').mockImplementation(async (failedThisTick) => {
      ticks.add(failedThisTick);
      return real(failedThisTick);
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reaches the backlog on the ticks after warm-up, not just at warm-up', async () => {
    await sleep(8 * INTERVAL_MS + 500);

    expect(ticks.size).toBeGreaterThanOrEqual(3);
  }, 20_000);
});
