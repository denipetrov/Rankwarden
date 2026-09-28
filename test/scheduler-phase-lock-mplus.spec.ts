import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Mythic+ archive against the sweep, on equal intervals (both an hour at
 * the defaults), with the real schedulers.
 *
 * Every hourly job starts its interval at boot, and Node fires timers of one
 * length together, in the order they were set, for the life of the process.
 * The sweep is set first, so every archive tick found it running. The tick used
 * to skip on that, and ran only at warm-up: over eight intervals it reached the
 * backlog zero times. It now waits for the sweep to finish
 * (`ARCHIVE_WAIT_FOR_IDLE_MS`) and runs.
 */
describe('Mythic+ archive ticks on the same interval as the sweep', () => {
  let app: TestApp;
  let ticks = 0;

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      {
        INGEST_INTERVAL_MS: String(INTERVAL_MS),
        MPLUS_ARCHIVE_ENABLED: 'true',
        MPLUS_ARCHIVE_CHECK_INTERVAL_MS: String(INTERVAL_MS),
        ARCHIVE_WAIT_FOR_IDLE_MS: '5000',
      },
      undefined,
      undefined,
      new MplusWorld(),
    );
    const archive = app.app.get(MplusArchiveService);
    const real = archive.archiveBacklog.bind(archive);
    vi.spyOn(archive, 'archiveBacklog').mockImplementation(async () => {
      ticks += 1;
      return real();
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reaches the backlog on the ticks after warm-up, not just at warm-up', async () => {
    await sleep(8 * INTERVAL_MS + 500);

    // A sweep every interval, and an archive tick that lands on each one.
    expect(ticks).toBeGreaterThanOrEqual(5);
  }, 20_000);
});
