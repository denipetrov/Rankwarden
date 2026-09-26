import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive } from './support/hold.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * M1.4 — a first Mythic+ pass that throws still opens the archive's gate (C13).
 *
 * The archive waits for the first pass to finish. "Finish" has to include
 * "fail": `duringMplus` marks the warm-up in its `finally`, and a refactor that
 * moved it onto the success path would hold the archive shut for the life of
 * the process after one bad boot — with nothing in readiness to say so.
 *
 * Driven through the real schedulers: a PvP sweep finishing is what releases
 * the Mythic+ pass, as in production.
 */
describe('Mythic+ first pass failing', () => {
  let app: TestApp;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_ENABLED: 'true', MPLUS_ARCHIVE_ENABLED: 'true' },
      undefined,
      logger,
      new MplusWorld().seed('us', 20, 500),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M1.4 an empty catalogue fails the first pass loudly, and the archive may still try', async () => {
    const coordinator = app.app.get(IngestionCoordinator);
    expect(coordinator.isMplusWarmedUp).toBe(false);

    // Raider.io's static data is down for everyone, so the catalogue is empty.
    app.raiderIo.failWith('mythic-plus/static-data', { status: 500 });

    // A sweep finishing warms live ingestion up (enrichment is off), which is
    // what starts the first Mythic+ pass.
    await holdActive(app.app, 'sweep')();
    await app.settle();

    const failures = logger.of('error', /Mythic\+ ingestion failed/);
    expect(failures, 'the scheduler logs it once, and survives').toHaveLength(1);
    expect(failures[0].detail).toMatch(/The Mythic\+ season catalogue is empty/);
    expect(app.raiderIo.countMatching('mythic-plus/runs'), 'nothing to fetch runs for').toBe(0);

    expect(coordinator.isMplusWarmedUp, 'a failed first pass still counts as the first').toBe(true);
    expect(coordinator.isMplusActive).toBe(false);

    // The archive's first tick ran, rather than waiting on a pass that will
    // never succeed until Raider.io is back.
    expect(app.app.get(MplusArchiveService).lastStatus.lastTickAt).not.toBeNull();
  });
});
