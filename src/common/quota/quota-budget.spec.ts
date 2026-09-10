import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../config/env.schema.js';
import { QuotaBudget, quotaConsumerFor } from './quota-budget.service.js';

const MINUTE = 60_000;

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) =>
      ({
        QUOTA_HOURLY_LIMIT: 36_000,
        QUOTA_UTILISATION: 0.9,
        QUOTA_ENRICHMENT_HEADROOM: 3,
        QUOTA_SWEEP_RESERVE: 1_000,
        ...overrides,
      })[key],
  }) as unknown as ConfigService<Env, true>;

describe('QuotaBudget', () => {
  let budget: QuotaBudget;
  let now: number;

  beforeEach(() => {
    budget = new QuotaBudget(config());
    now = Date.UTC(2026, 8, 10, 12, 0, 0);
    budget.now = () => now;
  });

  describe('shares', () => {
    it('plans against the usable part of the cap, not the whole of it', () => {
      expect(budget.hourlyLimit).toBe(36_000);
      // The margin absorbs requests already in flight and retries on batches
      // sized before they failed — neither of which a budget sees coming.
      expect(budget.usable).toBe(32_400);
    });

    it('gives enrichment a third of the hour', () => {
      expect(budget.enrichmentShare).toBe(12_000);
      expect(budget.allowance('enrichment')).toBe(12_000);
    });

    it('gives the archive only what the sweep and enrichment leave', () => {
      // 32,400 usable, less the sweep's 1,000 and enrichment's 12,000.
      expect(budget.allowance('archive')).toBe(19_400);
    });
  });

  describe('priority', () => {
    it('lets enrichment spend its share and no more', () => {
      budget.record('enrichment', 11_500);

      expect(budget.allowance('enrichment')).toBe(500);

      budget.record('enrichment', 500);
      expect(budget.allowance('enrichment')).toBe(0);
    });

    it('releases the sweep reserve as the sweep actually spends it', () => {
      // The reserve is held back only until the sweep has used it, so a sweep
      // that has already run is not counted twice against everyone else.
      const before = budget.allowance('archive');

      budget.record('sweep', 340);

      expect(budget.allowance('archive')).toBe(before);
    });

    it('charges a sweep that overruns its reserve to everyone else', () => {
      // The sweep is never throttled. When it spends more than was held back
      // for it, the difference comes out of what the others may spend.
      budget.record('sweep', 3_000);

      expect(budget.allowance('archive')).toBe(19_400 - 2_000);
    });

    it('never lets the archive eat into enrichment that is still due', () => {
      budget.record('enrichment', 2_000);

      // Enrichment still has 10,000 it may claim this hour, and it keeps them.
      expect(budget.allowance('archive')).toBe(19_400);
    });

    it('stops everything but the sweep once the usable hour is gone', () => {
      budget.record('archive', 19_400);
      budget.record('enrichment', 12_000);

      expect(budget.allowance('archive')).toBe(0);
      expect(budget.allowance('enrichment')).toBe(0);
    });

    it('lets untracked traffic reduce the room for everyone', () => {
      // Season refreshes and admin calls are never throttled, but they are
      // real requests and cannot hide from the total.
      budget.record('other', 500);

      expect(budget.allowance('archive')).toBe(18_900);
    });

    it('never reports a negative allowance', () => {
      budget.record('sweep', 50_000);

      expect(budget.allowance('enrichment')).toBe(0);
      expect(budget.allowance('archive')).toBe(0);
    });
  });

  describe('the rolling hour', () => {
    it('forgets requests once they are an hour old', () => {
      budget.record('enrichment', 12_000);
      expect(budget.allowance('enrichment')).toBe(0);

      now += 62 * MINUTE;

      expect(budget.spent('enrichment')).toBe(0);
      expect(budget.allowance('enrichment')).toBe(12_000);
    });

    it('releases spend gradually rather than all at once on the hour', () => {
      budget.record('enrichment', 6_000);
      now += 30 * MINUTE;
      budget.record('enrichment', 6_000);

      now += 32 * MINUTE;

      // The first half has aged out; the second is still inside the window.
      expect(budget.spent('enrichment')).toBe(6_000);
    });

    it('errs towards remembering a request slightly too long, not too short', () => {
      budget.record('enrichment', 100);

      now += 60 * MINUTE;

      // Exactly an hour on it is still counted: over-counting is the safe
      // direction for a quota.
      expect(budget.spent('enrichment')).toBe(100);
    });

    it('does not carry a stale bucket over when its slot comes round again', () => {
      budget.record('archive', 1_000);
      now += 64 * MINUTE; // the same ring slot, a full lap later

      budget.record('archive', 5);

      expect(budget.spent('archive')).toBe(5);
    });
  });

  it('reports everything health needs in one snapshot', () => {
    budget.record('sweep', 340);
    budget.record('enrichment', 1_000);

    expect(budget.snapshot()).toMatchObject({
      hourlyLimit: 36_000,
      usable: 32_400,
      spent: { sweep: 340, enrichment: 1_000, archive: 0, other: 0, total: 1_340 },
      allowance: { enrichment: 11_000 },
      shares: { sweepReserve: 1_000, enrichment: 12_000 },
      enrichment: null,
    });
  });
});

describe('quotaConsumerFor', () => {
  it('charges each job its own requests', () => {
    expect(quotaConsumerFor('sweep')).toBe('sweep');
    expect(quotaConsumerFor('enrich')).toBe('enrichment');
    expect(quotaConsumerFor('archive')).toBe('archive');
  });

  it('charges everything else to other', () => {
    expect(quotaConsumerFor('snapshot')).toBe('other');
    expect(quotaConsumerFor('transition')).toBe('other');
    expect(quotaConsumerFor(undefined)).toBe('other');
  });
});
