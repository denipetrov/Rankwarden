import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import { redactSecrets } from './redact.js';

export type DependencyStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** Observed state for one dependency, or for one region of one dependency. */
export interface DependencyObservation {
  status: DependencyStatus;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** HTTP status of the last failure; null when the host was unreachable. */
  lastStatusCode: number | null;
  consecutiveFailures: number;
  checkedAt: string | null;
  latencyMs: number | null;
}

interface Sample {
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastStatusCode: number | null;
  consecutiveFailures: number;
  checkedAt: Date | null;
  latencyMs: number | null;
}

/**
 * How many consecutive failures separate "a request failed" from "the
 * dependency is down". One failure is noise on a metered third-party API;
 * three in a row without a success between them is an outage.
 */
const DOWN_AFTER_FAILURES = 3;

/**
 * Observed health of the service's dependencies, written by the collaborators
 * that already talk to them and read by the health endpoints.
 *
 * Passive by construction: nothing here issues a request. The health endpoints
 * are unauthenticated, so probing Blizzard per hit would turn a public URL into
 * free amplification into a metered API — the state reported is the state real
 * traffic has already observed.
 */
@Injectable()
export class DependencyHealth {
  private readonly blizzard = new Map<string, Sample>();
  private readonly secrets: string[];

  constructor(config: ConfigService<Env, true>) {
    this.secrets = [
      config.get('BLIZZARD_CLIENT_SECRET', { infer: true }),
      config.get('BLIZZARD_CLIENT_ID', { infer: true }),
    ].filter((secret): secret is string => Boolean(secret));
  }

  recordBlizzardSuccess(region: string, latencyMs: number): void {
    const sample = this.sampleFor(region);
    sample.lastSuccessAt = new Date();
    sample.checkedAt = sample.lastSuccessAt;
    sample.latencyMs = latencyMs;
    // lastError is deliberately kept: health that forgets the outage the moment
    // it ends is useless in the post-mortem that follows.
    sample.consecutiveFailures = 0;
  }

  recordBlizzardFailure(region: string, reason: string, statusCode: number | null = null): void {
    const sample = this.sampleFor(region);
    sample.lastErrorAt = new Date();
    sample.checkedAt = sample.lastErrorAt;
    sample.lastError = this.redact(reason);
    sample.lastStatusCode = statusCode;
    sample.consecutiveFailures += 1;
  }

  /** Per-region observations, so three healthy regions are not hidden by one bad one. */
  blizzardByRegion(): Record<string, DependencyObservation> {
    return Object.fromEntries(
      [...this.blizzard].map(([region, sample]) => [region, this.describe(sample)]),
    );
  }

  /** The worst status across observed regions; unknown until traffic has flowed. */
  blizzardStatus(): DependencyStatus {
    const statuses = [...this.blizzard.values()].map((sample) => this.statusOf(sample));
    if (statuses.length === 0) return 'unknown';
    if (statuses.includes('down')) return 'down';
    if (statuses.includes('degraded')) return 'degraded';

    return 'ok';
  }

  /** Regions currently failing, named rather than folded into a boolean. */
  failingRegions(): string[] {
    return [...this.blizzard]
      .filter(([, sample]) => this.statusOf(sample) !== 'ok')
      .map(([region]) => region);
  }

  redact(value: string): string {
    return redactSecrets(value, this.secrets);
  }

  private sampleFor(region: string): Sample {
    const existing = this.blizzard.get(region);
    if (existing) return existing;

    const sample: Sample = {
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      lastStatusCode: null,
      consecutiveFailures: 0,
      checkedAt: null,
      latencyMs: null,
    };
    this.blizzard.set(region, sample);

    return sample;
  }

  private statusOf(sample: Sample): DependencyStatus {
    if (sample.consecutiveFailures >= DOWN_AFTER_FAILURES) return 'down';
    if (sample.consecutiveFailures > 0) return 'degraded';
    if (!sample.lastSuccessAt) return 'unknown';

    return 'ok';
  }

  private describe(sample: Sample): DependencyObservation {
    return {
      status: this.statusOf(sample),
      lastSuccessAt: sample.lastSuccessAt?.toISOString() ?? null,
      lastError: sample.lastError,
      lastErrorAt: sample.lastErrorAt?.toISOString() ?? null,
      lastStatusCode: sample.lastStatusCode,
      consecutiveFailures: sample.consecutiveFailures,
      checkedAt: sample.checkedAt?.toISOString() ?? null,
      latencyMs: sample.latencyMs,
    };
  }
}
