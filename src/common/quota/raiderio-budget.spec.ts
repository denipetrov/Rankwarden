import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { quotaConsumerFor } from './quota-budget.service.js';
import { RaiderIoBudget, raiderIoConsumerFor } from './raiderio-budget.service.js';

const env: Record<string, unknown> = {
  RAIDERIO_MINUTE_LIMIT: 1_000,
  RAIDERIO_UTILISATION: 0.9,
  RAIDERIO_ARCHIVE_SHARE: 0.5,
};

function budgetAt(start = 0) {
  const budget = new RaiderIoBudget({
    get: (key: string) => env[key],
  } as unknown as ConfigService<never, true>);
  let now = start;
  budget.now = () => now;

  return { budget, advance: (ms: number) => (now += ms) };
}

describe('raiderIoConsumerFor', () => {
  it('charges an M+ run to the M+ consumer', () => {
    expect(raiderIoConsumerFor('mplus')).toBe('mplus');
  });

  it('charges everything else to the catch-all', () => {
    for (const kind of [
      'sweep',
      'enrich',
      'archive',
      'snapshot',
      'transition',
      undefined,
    ] as const) {
      expect(raiderIoConsumerFor(kind)).toBe('other');
    }
  });
});

describe('quotaConsumerFor', () => {
  /**
   * The brief's warning made explicit: an M+ run must not look like a Blizzard
   * job to the Blizzard budget. It falls in `other`, which is counted but never
   * throttled — correct only because M+ makes no Blizzard requests at all.
   */
  it('does not map an M+ run onto any budgeted Blizzard consumer', () => {
    const consumer = quotaConsumerFor('mplus');

    expect(consumer).toBe('other');
    expect(consumer).not.toBe('enrichment');
    expect(consumer).not.toBe('archive');
    expect(consumer).not.toBe('sweep');
  });
});

describe('RaiderIoBudget', () => {
  it('plans against the utilisation margin, not the raw limit', () => {
    const { budget } = budgetAt();

    expect(budget.minuteLimit).toBe(1_000);
    expect(budget.usable).toBe(900);
    expect(budget.allowance()).toBe(900);
  });

  it('counts every consumer against the one allowance', () => {
    const { budget } = budgetAt();

    budget.record('mplus', 500);
    budget.record('other', 100);

    expect(budget.spent('mplus')).toBe(500);
    expect(budget.spent()).toBe(600);
    expect(budget.allowance(), 'other spends from the same minute').toBe(300);
  });

  it('never reports a negative allowance', () => {
    const { budget } = budgetAt();

    budget.record('mplus', 5_000);

    expect(budget.allowance()).toBe(0);
  });

  it('recovers as the minute rolls, not all at once on the hour', () => {
    const { budget, advance } = budgetAt();

    budget.record('mplus', 900);
    expect(budget.allowance()).toBe(0);

    // Half a minute later the window still holds the whole burst: this is a
    // rolling minute, not a minute that resets on the clock edge.
    advance(30_000);
    expect(budget.allowance()).toBe(0);

    advance(31_000);
    expect(budget.allowance()).toBe(900);
  });

  it('publishes an outlook for readiness to read', () => {
    const { budget } = budgetAt();

    expect(budget.snapshot().mplus).toBeNull();

    budget.publishMplusOutlook({
      computedAt: new Date(0).toISOString(),
      regions: 5,
      regionsComplete: 5,
      pagesPlanned: 5_005,
      pagesFetched: 5_005,
      pagesFailed: 0,
      runs: 100_100,
      characters: 40_000,
      durationMs: 400_000,
      requests: 5_005,
      capacityPerMinute: 900,
      feasible: true,
      stoppedEarly: null,
    });

    expect(budget.snapshot().mplus?.runs).toBe(100_100);
  });
});

describe('RaiderIoBudget archive share', () => {
  it('maps the archive run to its own consumer', () => {
    expect(raiderIoConsumerFor('mplus-archive')).toBe('mplusArchive');
  });

  it('caps the archive at its share of the minute', () => {
    const { budget } = budgetAt();

    expect(budget.archiveShare).toBe(450);
    budget.record('mplusArchive', 450);

    expect(budget.allowanceFor('mplusArchive'), 'the archive has spent its share').toBe(0);
    expect(budget.allowanceFor('mplus'), 'the live pass keeps the rest').toBe(450);
  });

  /**
   * The reason for the cap. Whatever the archive spent just before a live pass
   * starts, the pass begins with at least half the minute.
   */
  it('always leaves the live pass at least the other half', () => {
    const { budget } = budgetAt();

    // An archive that spends everything it is allowed, as it will in a gap
    // just before a live pass begins.
    budget.record('mplusArchive', budget.allowanceFor('mplusArchive'));

    expect(budget.allowanceFor('mplusArchive')).toBe(0);
    expect(budget.allowanceFor('mplus')).toBe(budget.usable - budget.archiveShare);
  });

  it('lets the live pass squeeze the archive out, not the other way round', () => {
    const { budget } = budgetAt();

    budget.record('mplus', 800);

    expect(budget.allowanceFor('mplusArchive'), 'room, not share, binds').toBe(100);
  });
});

describe('RaiderIoBudget.waitForAllowance', () => {
  it('resolves at once when there is room', async () => {
    const { budget } = budgetAt();

    await expect(budget.waitForAllowance('mplus', 10, 0)).resolves.toBe(true);
  });

  it('gives up immediately with no wait allowed, as the tests configure', async () => {
    const { budget } = budgetAt();
    budget.record('mplus', 900);

    await expect(budget.waitForAllowance('mplus', 1, 0)).resolves.toBe(false);
  });

  it('waits the window out rather than giving up', async () => {
    // The injected clock rolls the minute on the first poll, which is exactly
    // what real time does over sixty seconds.
    const { budget, advance } = budgetAt();
    budget.record('mplus', 900);
    let polls = 0;
    const original = budget.now;
    budget.now = () => {
      polls += 1;
      if (polls === 2) advance(61_000);
      return original();
    };

    await expect(budget.waitForAllowance('mplus', 1, 5_000)).resolves.toBe(true);
  });

  it('abandons the wait the moment it is told to', async () => {
    const { budget } = budgetAt();
    budget.record('mplusArchive', 450);

    await expect(budget.waitForAllowance('mplusArchive', 1, 60_000, () => true)).resolves.toBe(
      false,
    );
  });
});
