import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DependencyHealth,
  type DependencyObservation,
  type DependencyStatus,
} from '../common/health/dependency-health.service.js';
import { hostOf } from '../common/health/redact.js';
import { SweepEvents } from '../common/events/sweep-events.service.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { Env } from '../config/env.schema.js';
import { MongoService } from '../database/mongo.service.js';
import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
import { SeasonService } from '../season/season.service.js';
import { SeasonTransitionService } from '../season/season-transition.service.js';

/**
 * Liveness, readiness and season detail, deliberately split.
 *
 * Mongo is a hard dependency and Blizzard is a soft one: without Mongo the
 * service can do nothing, so readiness fails and traffic should be withdrawn;
 * without Blizzard it still holds every row already ingested, so only ingestion
 * is degraded. Failing readiness on a Blizzard outage would have an
 * orchestrator restart-loop the service through an incident it cannot fix, so
 * that case stays 200. Liveness touches neither, so a slow dependency can never
 * get a healthy process killed.
 */
@Controller('health')
export class HealthController {
  private readonly mongoHost: string;
  private readonly sweepIntervalMs: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly seasons: SeasonService,
    private readonly leaderboards: LeaderboardService,
    private readonly coordinator: IngestionCoordinator,
    private readonly sweeps: SweepEvents,
    private readonly mongo: MongoService,
    private readonly dependencies: DependencyHealth,
    private readonly transitions: SeasonTransitionService,
  ) {
    // The host, never the URI: a connection string carries its password in
    // userinfo and this endpoint is unauthenticated.
    this.mongoHost = hostOf(config.get('MONGODB_URI', { infer: true }));
    this.sweepIntervalMs = config.get('INGEST_INTERVAL_MS', { infer: true });
  }

  /**
   * Liveness. Process-local only: no database command, no upstream call, so it
   * answers under any dependency outage and cannot time out behind one.
   */
  @Get()
  status() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      sweepRunning: this.leaderboards.isRunning,
      seasons: this.seasons.describe(),
      jobs: this.jobs(),
    };
  }

  /** Readiness. Pings Mongo and reports what real traffic observed of Blizzard. */
  @Get('ready')
  async ready() {
    const ping = await this.mongo.ping();
    const blizzardRegions = this.dependencies.blizzardByRegion();
    const blizzard = this.dependencies.blizzardStatus();
    const staleSweep = this.staleSweep();

    const mongo: DependencyObservation & { host: string } = {
      host: this.mongoHost,
      status: ping.ok ? 'ok' : 'down',
      latencyMs: ping.latencyMs,
      lastSuccessAt: null,
      lastError: ping.error ? this.dependencies.redact(ping.error) : null,
      lastErrorAt: ping.error ? new Date().toISOString() : null,
      lastStatusCode: null,
      consecutiveFailures: ping.ok ? 0 : 1,
      checkedAt: new Date().toISOString(),
    };

    const overall = worstOf([
      ping.ok ? 'ok' : 'down',
      // Blizzard never fails readiness — it degrades it.
      blizzard === 'down' ? 'degraded' : blizzard,
      staleSweep ? 'degraded' : 'ok',
    ]);

    const payload = {
      status: overall,
      dependencies: {
        mongo,
        blizzard: {
          status: blizzard,
          failingRegions: this.dependencies.failingRegions(),
          regions: blizzardRegions,
        },
      },
      jobs: this.jobs(),
      staleSweep,
    };

    // Only a hard dependency withdraws traffic. The body is identical either
    // way, so a probe that reads it does not have to branch on the status.
    if (!ping.ok) throw new ServiceUnavailableException(payload);

    return payload;
  }

  /**
   * Per-season detail and the current transition plan. Kept off the readiness
   * path because both read the database.
   */
  @Get('seasons')
  async seasonDetail() {
    return {
      seasons: this.seasons.describe(),
      transition: await this.transitions.plan(),
    };
  }

  private jobs() {
    const last = this.sweeps.last;

    return {
      sweepRunning: this.coordinator.isSweepActive || this.leaderboards.isRunning,
      enrichmentRunning: this.coordinator.isEnrichmentActive,
      warmedUp: this.coordinator.isWarmedUp,
      lastSweep: last
        ? {
            finishedAt: last.finishedAt.toISOString(),
            brackets: last.brackets,
            failed: last.failed,
            removedCharacters: last.removedCharacters,
          }
        : null,
    };
  }

  /**
   * The failure nobody notices: the process is alive, both dependencies answer,
   * and the data has quietly stopped moving. Two intervals of grace, so one
   * skipped tick is not an alarm.
   */
  private staleSweep(): { since: string; toleranceMs: number } | null {
    const last = this.sweeps.last;
    const toleranceMs = this.sweepIntervalMs * 2;

    if (!last) return null;
    if (Date.now() - last.finishedAt.getTime() <= toleranceMs) return null;

    return { since: last.finishedAt.toISOString(), toleranceMs };
  }
}

/** Worst of a set of statuses; `unknown` never counts against readiness. */
function worstOf(statuses: readonly DependencyStatus[]): DependencyStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';

  return 'ok';
}
