import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * M4.10 — the archive and the live pass contending for one Raider.io minute
 * (A12, gap §7.6).
 *
 * `mplus-archive.spec.ts` shows the archive charging its own consumer. This is
 * the property the share exists for: however much the archive has to read, it
 * never takes more than its share of a minute, and the live pass that follows
 * it finds the rest. A 100-a-minute ceiling makes that observable in a handful
 * of pages: 90 usable, 45 of them the archive's.
 */
describe('Mythic+ archive share under contention', () => {
  let app: TestApp;
  let budget: RaiderIoBudget;
  const world = new MplusWorld();

  beforeAll(async () => {
    // A finished season deep enough that reading all of it would take the whole
    // minute several times over, and a live one for the pass.
    world.seed('us', 60 * 20, 900, 'season-mn-1').seed('us', 40, 500, 'season-mn-2');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us',
        RAIDERIO_MINUTE_LIMIT: '100',
        RAIDERIO_UTILISATION: '0.9',
        RAIDERIO_ARCHIVE_SHARE: '0.5',
        // The bucket has to fit inside 90 a minute, or the environment is refused.
        RAIDERIO_REQUESTS_PER_SECOND: '1',
        MPLUS_ARCHIVE_PAGES: '60',
      },
      undefined,
      undefined,
      world,
    );
    budget = app.app.get(RaiderIoBudget);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M4.10 the archive never spends past its share, and the pass finds the rest', async () => {
    expect(budget.usable).toBe(90);
    expect(budget.archiveShare).toBe(45);

    const archiveSpend: number[] = [];
    let passAllowance: number | null = null;

    app.raiderIo.beforeServe = (request) => {
      archiveSpend.push(budget.spent('mplusArchive'));
      if (
        passAllowance === null &&
        request.path === 'mythic-plus/runs' &&
        request.season === 'season-mn-2'
      ) {
        passAllowance = budget.allowanceFor('mplus');
      }
    };

    // The catalogue is due, so the tick reads it itself — and that is charged
    // to the archive as well, not to anyone else.
    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    expect(tick!.catalogue.refreshed).toBe(true);
    expect(tick!.stoppedEarly).toBe("the archive's share of the Raider.io budget is spent");
    expect(budget.spent('other'), 'nothing the archive did is charged elsewhere').toBe(0);
    expect(budget.spent('mplus')).toBe(0);
    expect(budget.spent('mplusArchive')).toBeGreaterThan(30);

    const pass = await app.app.get(MplusService).sweep();

    expect(Math.max(...archiveSpend), 'sampled at every request served').toBeLessThanOrEqual(45);
    expect(passAllowance).toBeGreaterThanOrEqual(45);
    expect(pass!.stoppedEarly, 'the pass never waits on archive spend').toBeNull();
    expect(budget.spent('mplusArchive'), 'the pass is charged to itself').toBeLessThanOrEqual(45);
    expect(budget.spent('mplus')).toBe(pass!.requests);
  });
});
