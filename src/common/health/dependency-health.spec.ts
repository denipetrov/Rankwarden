import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';

import { DependencyHealth } from './dependency-health.service.js';

const env: Record<string, unknown> = {
  BLIZZARD_CLIENT_ID: 'client-id-value',
  BLIZZARD_CLIENT_SECRET: 'client-secret-value',
};

describe('DependencyHealth', () => {
  let health: DependencyHealth;

  beforeEach(() => {
    health = new DependencyHealth({ get: (key: string) => env[key] } as unknown as ConfigService<
      never,
      true
    >);
  });

  it('reports unknown before any traffic has flowed', () => {
    // Nothing is probed actively, so there is genuinely nothing to say yet.
    expect(health.blizzardStatus()).toBe('unknown');
    expect(health.blizzardByRegion()).toEqual({});
  });

  it('reports ok once a request has succeeded', () => {
    health.recordBlizzardSuccess('us', 120);

    expect(health.blizzardStatus()).toBe('ok');
    expect(health.blizzardByRegion().us).toMatchObject({ status: 'ok', latencyMs: 120 });
  });

  it('treats a single failure as degraded, not as an outage', () => {
    health.recordBlizzardFailure('us', 'HTTP 500', 500);

    expect(health.blizzardStatus()).toBe('degraded');
  });

  it('calls it down once failures are sustained', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      health.recordBlizzardFailure('us', 'token request rejected');
    }

    expect(health.blizzardStatus()).toBe('down');
    expect(health.blizzardByRegion().us.consecutiveFailures).toBe(3);
  });

  it('keeps the status code, so throttling is distinguishable from dead credentials', () => {
    health.recordBlizzardFailure('us', 'HTTP 429', 429);
    health.recordBlizzardFailure('eu', 'HTTP 401', 401);
    health.recordBlizzardFailure('kr', 'connect ETIMEDOUT');

    expect(health.blizzardByRegion().us.lastStatusCode).toBe(429);
    expect(health.blizzardByRegion().eu.lastStatusCode).toBe(401);
    // No status at all is what an unreachable host looks like.
    expect(health.blizzardByRegion().kr.lastStatusCode).toBeNull();
  });

  it('names the failing region rather than folding it into a boolean', () => {
    health.recordBlizzardSuccess('us', 100);
    health.recordBlizzardSuccess('eu', 100);
    health.recordBlizzardSuccess('tw', 100);
    health.recordBlizzardFailure('kr', 'HTTP 503', 503);

    // Three of four regions ingesting is a materially different situation
    // from none of them.
    expect(health.failingRegions()).toEqual(['kr']);
    expect(health.blizzardByRegion().us.status).toBe('ok');
  });

  it('recovers on the next success but remembers the outage', () => {
    health.recordBlizzardFailure('us', 'HTTP 500', 500);
    health.recordBlizzardSuccess('us', 90);

    const observed = health.blizzardByRegion().us;
    expect(observed.status).toBe('ok');
    expect(observed.consecutiveFailures).toBe(0);
    // Health that forgets the outage the moment it ends is useless afterwards.
    expect(observed.lastError).toContain('HTTP 500');
    expect(observed.lastErrorAt).not.toBeNull();
  });

  it('never lets a credential into a reported error', () => {
    health.recordBlizzardFailure('us', 'auth failed using client-secret-value');

    expect(health.blizzardByRegion().us.lastError).not.toContain('client-secret-value');
  });
});
