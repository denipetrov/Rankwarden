import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulerRegistry } from '@nestjs/schedule';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { CapturingLogger } from './support/logger.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * M1.2 — both Mythic+ jobs off, as every deployment that predates them is
 * (gap §7.2).
 *
 * The season check is left on and there is no Raider.io key: the configuration
 * an existing deployment has after upgrading. Nothing Mythic+ may run, ask
 * Raider.io anything, or hold up the PvP side waiting for a first pass that is
 * never coming.
 */
describe('Mythic+ switched off', () => {
  let app: TestApp;
  const logger = new CapturingLogger();

  beforeAll(async () => {
    const world = new MplusWorld().seed('us', 20, 500);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        MPLUS_ENABLED: 'false',
        MPLUS_ARCHIVE_ENABLED: 'false',
        MPLUS_SEASON_REFRESH_ENABLED: 'true',
        MPLUS_TRANSITION_ENABLED: 'false',
        RAIDER_IO_API_KEY: '',
      },
      undefined,
      logger,
      world,
    );
    await app.settle();
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M1.2 boots, asks Raider.io nothing, and holds nothing up', async () => {
    expect(app.raiderIo.requests).toEqual([]);

    expect(logger.matching(/No Mythic\+ job is enabled; Mythic\+ season checks idle/)).toHaveLength(
      1,
    );
    expect(logger.matching(/Mythic\+ ingestion disabled/)).toHaveLength(1);

    const registry = app.app.get(SchedulerRegistry);
    expect(registry.doesExist('interval', 'mplus-season-check')).toBe(false);
    expect(registry.doesExist('interval', 'mplus-sweep')).toBe(false);

    // The Mythic+ archive gate is open: the PvP side is never made to wait on
    // a Mythic+ pass that is switched off.
    expect(app.app.get(IngestionCoordinator).isMplusWarmedUp).toBe(true);
  });

  it('M1.2 readiness reports Raider.io as unknown, and is not degraded by it', async () => {
    const ready = await getJson<{
      status: string;
      dependencies: { raiderio: { status: string } };
      mplus: { outlook: unknown; problems: string[] };
    }>(app.url(), '/health/ready');

    expect(ready.status).toBe(200);
    expect(ready.body.dependencies.raiderio.status).toBe('unknown');
    expect(ready.body.mplus).toEqual({ outlook: null, problems: [] });
    // Nothing else has run either, so nothing degrades it; `unknown` does not.
    expect(ready.body.status).toBe('ok');

    const live = await getJson<{ mplusSeasons: Record<string, unknown> }>(app.url(), '/health');
    expect(live.body.mplusSeasons).toEqual({});
  });
});
