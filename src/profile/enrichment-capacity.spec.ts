import { describe, expect, it } from 'vitest';

import { projectCapacity, type CapacityInputs } from './enrichment-capacity.js';

const DAY = 86_400_000;

const inputs = (overrides: Partial<CapacityInputs> = {}): CapacityInputs => ({
  population: 143_203,
  specsTtlMs: DAY,
  summaryTtlMs: 7 * DAY,
  enrichmentShare: 12_000,
  batchSize: 2_000,
  intervalMs: 300_000,
  oldestRefreshAgeMs: null,
  ...overrides,
});

describe('projectCapacity', () => {
  it('derives demand from the population and both TTLs', () => {
    // Daily specs plus weekly summaries: 1/24 + 1/168 requests a character an hour.
    expect(projectCapacity(inputs({ population: 168_000 })).demandPerHour).toBe(8_000);
  });

  it('scales demand with the population, not with anything configured', () => {
    const small = projectCapacity(inputs({ population: 50_000 }));
    const large = projectCapacity(inputs({ population: 100_000 }));

    expect(large.demandPerHour).toBe(small.demandPerHour * 2);
  });

  it('names the quota share as binding when the batch is roomy', () => {
    const outlook = projectCapacity(inputs());

    expect(outlook.bindingConstraint).toBe('quota share');
    expect(outlook.capacityPerHour).toBe(12_000);
  });

  it('names the batch size as binding when it is the smaller limit', () => {
    // Naming the binding limit is most of the value: raising the quota share
    // does nothing while the batch binds.
    const outlook = projectCapacity(inputs({ batchSize: 100 }));

    expect(outlook.bindingConstraint).toBe('batch size');
    expect(outlook.capacityPerHour).toBeLessThan(12_000);
  });

  it('is feasible exactly up to the sustainable population', () => {
    const ceiling = projectCapacity(inputs()).maxSustainablePopulation;

    expect(projectCapacity(inputs({ population: ceiling })).feasible).toBe(true);
    expect(projectCapacity(inputs({ population: ceiling + 100 })).feasible).toBe(false);
  });

  it('lengthening the specs TTL raises the ceiling, as the only lever once it is hit', () => {
    const daily = projectCapacity(inputs()).maxSustainablePopulation;
    const everyTwoDays = projectCapacity(inputs({ specsTtlMs: 2 * DAY })).maxSustainablePopulation;

    expect(everyTwoDays).toBeGreaterThan(daily * 1.7);
  });

  describe('behind', () => {
    it('is not behind while nothing has been enriched yet', () => {
      // A first fill has a large backlog and no timestamps; that is busy, not late.
      expect(projectCapacity(inputs({ oldestRefreshAgeMs: null })).behind).toBe(false);
    });

    it('is not behind at one TTL, which is simply due', () => {
      expect(projectCapacity(inputs({ oldestRefreshAgeMs: 1.5 * DAY })).behind).toBe(false);
    });

    it('is behind once the stalest refresh passes twice its TTL', () => {
      expect(projectCapacity(inputs({ oldestRefreshAgeMs: 2.1 * DAY })).behind).toBe(true);
    });
  });
});
