import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import type { RunKind } from '../logging/run-context.js';

/** Who spent a request. Anything outside a known job is `other`. */
export type QuotaConsumer = 'sweep' | 'enrichment' | 'archive' | 'other';

/** The jobs that ask permission before spending; the sweep never does. */
export type BudgetedConsumer = 'enrichment' | 'archive';

const CONSUMERS: readonly QuotaConsumer[] = ['sweep', 'enrichment', 'archive', 'other'];

export const HOUR_MS = 3_600_000;
const BUCKET_MS = 60_000;
/** Minutes counted: the current one and the previous sixty. See `spent`. */
const WINDOW_MINUTES = 60;
/** Ring size; anything above WINDOW_MINUTES + 1 works. */
const SLOTS = 64;

/** Maps a run to the consumer its requests are charged to. */
export function quotaConsumerFor(kind: RunKind | undefined): QuotaConsumer {
  switch (kind) {
    case 'sweep':
      return 'sweep';
    case 'enrich':
      return 'enrichment';
    case 'archive':
      return 'archive';
    default:
      // Season refreshes, snapshots, transitions and admin calls outside a job.
      // Tiny, never throttled, but counted so they cannot hide from the total.
      return 'other';
  }
}

/**
 * What enrichment can and cannot keep up with, as of its last run.
 *
 * Published by the enrichment service, read by the health endpoint, so
 * readiness can report it without any database I/O of its own.
 */
export interface EnrichmentOutlook {
  computedAt: string;
  /** Characters the enrichment pass serves. */
  population: number;
  /** Characters due right now, and the requests that would take. */
  dueCharacters: number;
  dueRequests: number;
  /** Requests the last run was allowed, and the characters that bought. */
  requestBudget: number;
  batch: number;
  /** Steady-state requests an hour needed to keep every TTL. */
  demandPerHour: number;
  /** Requests an hour enrichment can actually make, and what limits it. */
  capacityPerHour: number;
  bindingConstraint: 'quota share' | 'batch size';
  /** False when no amount of waiting will let enrichment keep the TTLs. */
  feasible: boolean;
  /** The largest population the TTLs can be kept for at current settings. */
  maxSustainablePopulation: number;
  /** Age of the stalest spec refresh among enriched characters. */
  oldestRefreshAgeMs: number | null;
  /** True when that age says the queue is falling behind, not just busy. */
  behind: boolean;
}

export interface QuotaSnapshot {
  hourlyLimit: number;
  usable: number;
  spent: Record<QuotaConsumer | 'total', number>;
  allowance: Record<BudgetedConsumer, number>;
  shares: { sweepReserve: number; enrichment: number };
  enrichment: EnrichmentOutlook | null;
}

interface Bucket {
  minute: number;
  counts: Record<QuotaConsumer, number>;
}

/**
 * One hourly request budget for every Blizzard call the service makes.
 *
 * Blizzard enforces 36,000 requests an hour across the whole client, but each
 * job used to carry a private rate limiter sized as if it owned that quota —
 * the archive alone was allowed 10/s, which is the entire hourly cap. Nothing
 * added the jobs up, so during a backfill the archive, running in every gap
 * between enrichment passes, plus enrichment and the sweep, came to roughly
 * 41,000 an hour.
 *
 * Every real request — retries included, since Blizzard counts those — is
 * recorded here by the HTTP client and charged to the job that made it. Jobs
 * then draw from shares in priority order:
 *
 * - the sweep is never throttled; `QUOTA_SWEEP_RESERVE` is held back for it
 *   until it has spent that much in the window;
 * - enrichment may plan at most `hourlyLimit / QUOTA_ENRICHMENT_HEADROOM`;
 * - the archive gets what is left, after the reserve and enrichment's unspent
 *   share are held back.
 *
 * Only `usable` (`hourlyLimit x QUOTA_UTILISATION`) is ever planned against.
 * The margin absorbs requests already in flight when a check is made, and
 * retries on batches sized before they failed.
 *
 * In memory, per process: a restart forgets the last hour. That is a known
 * gap rather than an oversight — persisting every request would cost more
 * than the overrun it guards against, and Blizzard's own 429s, which the
 * client retries, are the backstop.
 */
@Injectable()
export class QuotaBudget {
  readonly hourlyLimit: number;
  readonly usable: number;
  readonly enrichmentShare: number;
  readonly sweepReserve: number;

  /** Injectable clock, so the rolling window can be tested without waiting. */
  now: () => number = Date.now;

  private readonly buckets: Bucket[] = Array.from({ length: SLOTS }, () => ({
    minute: Number.NEGATIVE_INFINITY,
    counts: emptyCounts(),
  }));
  private outlook: EnrichmentOutlook | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.hourlyLimit = config.get('QUOTA_HOURLY_LIMIT', { infer: true });
    this.usable = Math.floor(this.hourlyLimit * config.get('QUOTA_UTILISATION', { infer: true }));
    this.enrichmentShare = Math.floor(
      this.hourlyLimit / config.get('QUOTA_ENRICHMENT_HEADROOM', { infer: true }),
    );
    this.sweepReserve = config.get('QUOTA_SWEEP_RESERVE', { infer: true });
  }

  /** Charges `count` requests to a consumer. Called once per real attempt. */
  record(consumer: QuotaConsumer, count = 1): void {
    const minute = Math.floor(this.now() / BUCKET_MS);
    const bucket = this.buckets[minute % SLOTS];

    if (bucket.minute !== minute) {
      bucket.minute = minute;
      bucket.counts = emptyCounts();
    }

    bucket.counts[consumer] += count;
  }

  /**
   * Requests spent in the rolling hour, by one consumer or in total.
   *
   * Counted in one-minute buckets over the current minute and the previous
   * sixty, so a request is remembered for between sixty and sixty-one
   * minutes. That errs towards over-counting, which is the right direction
   * for a quota.
   */
  spent(consumer?: QuotaConsumer): number {
    const current = Math.floor(this.now() / BUCKET_MS);
    let total = 0;

    for (const bucket of this.buckets) {
      if (bucket.minute < current - WINDOW_MINUTES || bucket.minute > current) continue;

      total += consumer
        ? bucket.counts[consumer]
        : CONSUMERS.reduce((sum, name) => sum + bucket.counts[name], 0);
    }

    return total;
  }

  /** Requests a job may still spend right now without eating a higher share. */
  allowance(consumer: BudgetedConsumer): number {
    const total = this.spent();
    const sweepHeld = Math.max(0, this.sweepReserve - this.spent('sweep'));
    const enrichmentSpent = this.spent('enrichment');
    const room = this.usable - total - sweepHeld;

    if (consumer === 'enrichment') {
      return Math.max(0, Math.min(this.enrichmentShare - enrichmentSpent, room));
    }

    // The archive is history that has already waited months; it takes nothing
    // enrichment could still claim this hour.
    const enrichmentHeld = Math.max(0, this.enrichmentShare - enrichmentSpent);

    return Math.max(0, room - enrichmentHeld);
  }

  publishEnrichmentOutlook(outlook: EnrichmentOutlook): void {
    this.outlook = outlook;
  }

  get enrichmentOutlook(): EnrichmentOutlook | null {
    return this.outlook;
  }

  snapshot(): QuotaSnapshot {
    const spent = Object.fromEntries(CONSUMERS.map((name) => [name, this.spent(name)])) as Record<
      QuotaConsumer,
      number
    >;

    return {
      hourlyLimit: this.hourlyLimit,
      usable: this.usable,
      spent: { ...spent, total: this.spent() },
      allowance: {
        enrichment: this.allowance('enrichment'),
        archive: this.allowance('archive'),
      },
      shares: { sweepReserve: this.sweepReserve, enrichment: this.enrichmentShare },
      enrichment: this.outlook,
    };
  }
}

function emptyCounts(): Record<QuotaConsumer, number> {
  return { sweep: 0, enrichment: 0, archive: 0, other: 0 };
}
