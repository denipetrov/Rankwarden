import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import type { RunKind } from '../logging/run-context.js';
import { RollingWindow } from './rolling-window.js';

/** Who spent a Raider.io request. Anything outside a known job is `other`. */
export type RaiderIoConsumer = 'mplus' | 'mplusArchive' | 'other';

const CONSUMERS: readonly RaiderIoConsumer[] = ['mplus', 'mplusArchive', 'other'];

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
  switch (kind) {
    case 'mplus':
      return 'mplus';
    case 'mplus-archive':
      return 'mplusArchive';
    default:
      return 'other';
  }
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
  /** Of that, time spent paused for live PvP ingestion. */
  pausedMs: number;
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
  /** The most the archive may spend in any one minute. */
  archiveShare: number;
  spent: Record<RaiderIoConsumer | 'total', number>;
  allowance: Record<'mplus' | 'mplusArchive', number>;
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
  /** Requests a minute the archive may spend at most. See `allowanceFor`. */
  readonly archiveShare: number;

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
    this.archiveShare = Math.floor(
      this.usable * config.get('RAIDERIO_ARCHIVE_SHARE', { infer: true }),
    );
  }

  /** Charges `count` requests to a consumer. Called once per real attempt. */
  record(consumer: RaiderIoConsumer, count = 1): void {
    this.window.record(consumer, count);
    this.changed = true;
  }

  /** Whether anything was charged since the window was last taken for saving. */
  private changed = false;

  /** The minute's buckets, for `RaiderIoBudgetStore`. Clears the changed flag. */
  takeSnapshot(): { index: number; counts: Record<RaiderIoConsumer, number> }[] | null {
    if (!this.changed) return null;
    this.changed = false;

    return this.window.snapshot();
  }

  /** Puts a saved minute back, after a restart. */
  restoreSnapshot(
    saved: readonly { index: number; counts: Partial<Record<RaiderIoConsumer, number>> }[],
  ): void {
    this.window.restore(saved);
  }

  /** Requests spent in the rolling minute, by one consumer or in total. */
  spent(consumer?: RaiderIoConsumer): number {
    return this.window.spent(consumer);
  }

  /** Requests that may still be spent right now by the live pass. */
  allowance(): number {
    return this.allowanceFor('mplus');
  }

  /**
   * Requests a consumer may still spend right now.
   *
   * The live pass may use the whole window. The archive is capped at
   * `archiveShare` of it, and the cap is what protects the live pass rather
   * than politeness: both spend from one per-minute window, the archive runs in
   * the gaps before a live pass starts, and a window the archive had just
   * filled would leave the live pass nothing for up to a minute. Capped, the
   * live pass always inherits at least `usable - archiveShare` the moment it
   * begins, and the rest within one window.
   */
  allowanceFor(consumer: 'mplus' | 'mplusArchive'): number {
    const room = Math.max(0, this.usable - this.spent());

    if (consumer === 'mplus') return room;

    return Math.max(0, Math.min(room, this.archiveShare - this.spent('mplusArchive')));
  }

  /**
   * Waits for a consumer's allowance to reach `needed`, for at most `maxWaitMs`.
   *
   * A per-minute ceiling is a **rate**, so a job that meets it should slow down
   * rather than give up: the window frees itself within sixty seconds. Giving
   * up is what the live pass used to do, and once the archive shared the window
   * that turned "someone else spent this minute" into a pass that stopped early,
   * skipped its prune and reported degraded for a whole interval.
   *
   * Resolves `true` once there is room, `false` when the wait runs out or
   * `abandon` says to stop — a higher-priority job starting, for the archive.
   * Polls rather than computing the exact moment, because the window rolls in
   * one-second buckets and something else may spend in the meantime.
   */
  async waitForAllowance(
    consumer: 'mplus' | 'mplusArchive',
    needed: number,
    maxWaitMs: number,
    abandon: () => boolean = () => false,
  ): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;

    for (;;) {
      if (this.allowanceFor(consumer) >= Math.max(1, needed)) return true;
      if (abandon() || Date.now() >= deadline) return false;

      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(BUCKET_MS, Math.max(0, deadline - Date.now()))),
      );
    }
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
      archiveShare: this.archiveShare,
      spent: { ...spent, total: this.spent() },
      allowance: {
        mplus: this.allowanceFor('mplus'),
        mplusArchive: this.allowanceFor('mplusArchive'),
      },
      mplus: this.outlook,
    };
  }
}
