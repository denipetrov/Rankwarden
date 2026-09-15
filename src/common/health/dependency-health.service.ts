import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';
import { redactSecrets } from './redact.js';

export type DependencyStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** The upstreams observed here. Both are soft dependencies; only Mongo is hard. */
export type UpstreamProvider = 'blizzard' | 'raiderio';

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
  private readonly upstreams = new Map<UpstreamProvider, Map<string, Sample>>();
  private readonly secrets: string[];

  constructor(config: ConfigService<Env, true>) {
    this.secrets = [
      config.get('BLIZZARD_CLIENT_SECRET', { infer: true }),
      config.get('BLIZZARD_CLIENT_ID', { infer: true }),
      // The Raider.io key travels as a query parameter, so it turns up inside
      // any url an error message quotes. The client keeps it out of the urls it
      // reports, and this catches whatever quotes one it did not build.
      config.get('RAIDER_IO_API_KEY', { infer: true }),
    ].filter((secret): secret is string => Boolean(secret));
  }

  /** Records a successful call to one region of one upstream. */
  recordSuccess(provider: UpstreamProvider, region: string, latencyMs: number): void {
    const sample = this.sampleFor(provider, region);
    sample.lastSuccessAt = new Date();
    sample.checkedAt = sample.lastSuccessAt;
    sample.latencyMs = latencyMs;
    // lastError is deliberately kept: health that forgets the outage the moment
    // it ends is useless in the post-mortem that follows.
    sample.consecutiveFailures = 0;
  }

  /** Records a failed call to one region of one upstream. */
  recordFailure(
    provider: UpstreamProvider,
    region: string,
    reason: string,
    statusCode: number | null = null,
  ): void {
    const sample = this.sampleFor(provider, region);
    sample.lastErrorAt = new Date();
    sample.checkedAt = sample.lastErrorAt;
    sample.lastError = this.redact(reason);
    sample.lastStatusCode = statusCode;
    sample.consecutiveFailures += 1;
  }

  /** Per-region observations, so three healthy regions are not hidden by one bad one. */
  byRegion(provider: UpstreamProvider): Record<string, DependencyObservation> {
    return Object.fromEntries(
      [...this.regionsOf(provider)].map(([region, sample]) => [region, this.describe(sample)]),
    );
  }

  /** The worst status across observed regions; unknown until traffic has flowed. */
  statusFor(provider: UpstreamProvider): DependencyStatus {
    const statuses = [...this.regionsOf(provider).values()].map((sample) => this.statusOf(sample));
    if (statuses.length === 0) return 'unknown';
    if (statuses.includes('down')) return 'down';
    if (statuses.includes('degraded')) return 'degraded';

    return 'ok';
  }

  /** Regions currently failing, named rather than folded into a boolean. */
  failingRegionsFor(provider: UpstreamProvider): string[] {
    return [...this.regionsOf(provider)]
      .filter(([, sample]) => this.statusOf(sample) !== 'ok')
      .map(([region]) => region);
  }

  // Blizzard-named wrappers. The provider-keyed methods above are the real
  // ones; these stay because Blizzard is by far the most-called upstream and
  // naming it at the call site reads better than passing a literal.
  recordBlizzardSuccess(region: string, latencyMs: number): void {
    this.recordSuccess('blizzard', region, latencyMs);
  }

  recordBlizzardFailure(region: string, reason: string, statusCode: number | null = null): void {
    this.recordFailure('blizzard', region, reason, statusCode);
  }

  blizzardByRegion(): Record<string, DependencyObservation> {
    return this.byRegion('blizzard');
  }

  blizzardStatus(): DependencyStatus {
    return this.statusFor('blizzard');
  }

  failingRegions(): string[] {
    return this.failingRegionsFor('blizzard');
  }

  redact(value: string): string {
    return redactSecrets(value, this.secrets);
  }

  /** The per-region map for an upstream, created on first observation. */
  private regionsOf(provider: UpstreamProvider): Map<string, Sample> {
    const existing = this.upstreams.get(provider);
    if (existing) return existing;

    const created = new Map<string, Sample>();
    this.upstreams.set(provider, created);

    return created;
  }

  private sampleFor(provider: UpstreamProvider, region: string): Sample {
    const regions = this.regionsOf(provider);
    const existing = regions.get(region);
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
    regions.set(region, sample);

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
