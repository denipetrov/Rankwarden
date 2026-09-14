import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import type { RunKind } from '../logging/run-context.js';
import { RollingWindow } from './rolling-window.js';

/** Who spent a Raider.io request. Anything outside the M+ job is `other`. */
export type RaiderIoConsumer = 'mplus' | 'other';

const CONSUMERS: readonly RaiderIoConsumer[] = ['mplus', 'other'];

export const MINUTE_MS = 60_000;
/**
 * One-second buckets over the current second and the previous sixty.
 *
 * Blizzard's budget counts minutes into an hour; this one counts seconds into
 * a minute, because that is the window Raider.io actually enforces. A
 * minute-resolution window would be useless here — the whole window would be a
 * single bucket, so the budget would read zero for 59 seconds and then the
 * entire minute's spend at once.
 */
const BUCKET_MS = 1_000;
const WINDOW_SECONDS = 60;

/** Maps a run to the consumer its Raider.io requests are charged to. */
export function raiderIoConsumerFor(kind: RunKind | undefined): RaiderIoConsumer {
  return kind === 'mplus' ? 'mplus' : 'other';
}

/**
 * What the M+ sweep managed on its last pass, for the health endpoint to read.
 *
 * The Raider.io counterpart to `EnrichmentOutlook`: a job publishing its own
 * verdict from memory, so readiness can report whether M+ is keeping up
 * without adding a database read to a probe.
 */
export interface MplusOutlook {
  computedAt: string;
  /** Regions the pass covered, and how many finished without a shortfall. */
  regions: number;
  regionsComplete: number;
  /** Pages asked for and pages that came back, across every region. */
  pagesPlanned: number;
  pagesFetched: number;
  pagesFailed: number;
  /** What the pass ingested. */
  runs: number;
  characters: number;
  /** How long the pass took, and what it would take to keep the cadence. */
  durationMs: number;
  requests: number;
  /** Requests a minute the budget permits, and what a full pass needs. */
  capacityPerMinute: number;
  /** False when a full pass cannot finish inside its own interval. */
  feasible: boolean;
  /** Set when the pass gave up early, naming why. */
  stoppedEarly: string | null;
}

export interface RaiderIoQuotaSnapshot {
  minuteLimit: number;
  usable: number;
  spent: Record<RaiderIoConsumer | 'total', number>;
  allowance: number;
  mplus: MplusOutlook | null;
}

/**
 * The request budget for every Raider.io call the service makes.
 *
 * Deliberately *not* `QuotaBudget`. That one models Blizzard's 36,000-an-hour
 * cap and divides it between the sweep, enrichment and the archive; charging
 * foreign requests to it would throttle those three for no reason and make
 * `/health/ready` misreport all of them. The two upstreams meter independently,
 * so their budgets do too. What they share is `RollingWindow` — the counter
 * itself — rather than the policy on top of it, because the policies have
 * nothing in common: Blizzard's has four consumers and three priority shares,
 * this one has a single job and a flat ceiling.
 *
 * Raider.io documents 200 requests a minute unauthenticated and lifts that for
 * registered applications; a 300-request burst on the configured key drew no
 * 429, and no `X-RateLimit-*` or `Retry-After` header is exposed on a success,
 * so the ceiling is configuration (`RAIDERIO_MINUTE_LIMIT`) rather than
 * something that can be read back from a response. Only
 * `limit x RAIDERIO_UTILISATION` is ever planned against, so the margin absorbs
 * requests already in flight when a check is made and retries on work sized
 * before it failed — the same reasoning as `QUOTA_UTILISATION`.
 *
 * Charged per attempt, retries included, by the HTTP client's `beforeRequest`
 * hook, and attributed through the run context so no call site passes a label.
 */
@Injectable()
export class RaiderIoBudget {
  readonly minuteLimit: number;
  readonly usable: number;

  private readonly window = new RollingWindow<RaiderIoConsumer>(
    CONSUMERS,
    BUCKET_MS,
    WINDOW_SECONDS,
  );
  private outlook: MplusOutlook | null = null;

  /** Injectable clock, so the rolling window can be tested without waiting. */
  get now(): () => number {
    return this.window.now;
  }

  set now(clock: () => number) {
    this.window.now = clock;
  }

  constructor(config: ConfigService<Env, true>) {
    this.minuteLimit = config.get('RAIDERIO_MINUTE_LIMIT', { infer: true });
    this.usable = Math.floor(
      this.minuteLimit * config.get('RAIDERIO_UTILISATION', { infer: true }),
    );
  }

  /** Charges `count` requests to a consumer. Called once per real attempt. */
  record(consumer: RaiderIoConsumer, count = 1): void {
    this.window.record(consumer, count);
  }

  /** Requests spent in the rolling minute, by one consumer or in total. */
  spent(consumer?: RaiderIoConsumer): number {
    return this.window.spent(consumer);
  }

  /**
   * Requests that may still be spent right now.
   *
   * One number rather than a share per consumer: only the M+ job spends here,
   * and `other` exists to keep anything outside a run visible in the total
   * rather than to be budgeted against separately.
   */
  allowance(): number {
    return Math.max(0, this.usable - this.spent());
  }

  publishMplusOutlook(outlook: MplusOutlook): void {
    this.outlook = outlook;
  }

  get mplusOutlook(): MplusOutlook | null {
    return this.outlook;
  }

  snapshot(): RaiderIoQuotaSnapshot {
    const spent = Object.fromEntries(CONSUMERS.map((name) => [name, this.spent(name)])) as Record<
      RaiderIoConsumer,
      number
    >;

    return {
      minuteLimit: this.minuteLimit,
      usable: this.usable,
      spent: { ...spent, total: this.spent() },
      allowance: this.allowance(),
      mplus: this.outlook,
    };
  }
}
