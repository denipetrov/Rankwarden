import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * M12.8 (infeasible) — readiness names a cadence that cannot be kept.
 *
 * Its own file, because it needs an interval shorter than a pass: five pages
 * at the 900-a-minute usable budget take a third of a second, and the interval
 * here is 300ms. `MPLUS_ENABLED` stays off, which is also what lets the
 * environment through — the boot-time check refuses this only while the pass
 * is on — and every pass is driven by hand.
 */
describe('Mythic+ readiness with an infeasible cadence', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', MPLUS_INTERVAL_MS: '300' },
      undefined,
      undefined,
      new MplusWorld().seed('us', 40, 500),
    );
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M12.8 an interval shorter than a pass is one problem line, and degraded rather than down', async () => {
    const pass = await app.app.get(MplusService).sweep();
    expect(pass!.stoppedEarly).toBeNull();

    const ready = await getJson<{
      status: string;
      mplus: { outlook: { feasible: boolean }; problems: string[] };
    }>(app.url(), '/health/ready');

    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.mplus.outlook.feasible).toBe(false);
    expect(ready.body.mplus.problems).toEqual([
      'a full pass is 5 pages, more than the 900 a minute the budget allows can deliver inside one interval',
    ]);
  });
});
