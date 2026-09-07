import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { PvpApi } from '../blizzard/pvp.api.js';
import type { Region } from '../blizzard/blizzard.constants.js';
import { SeasonEvents } from './season-events.service.js';
import { SeasonStateRepository } from './season-state.repository.js';

export interface CachedSeason {
  id: number;
  name?: string;
  startsAt: Date;
  /** Null while the season is still running. */
  endsAt: Date | null;
  /** When this was last read from Blizzard, or loaded from persisted state. */
  observedAt: Date;
}

/**
 * Record of the active PvP season per region. Resolved at startup and refreshed
 * before every sweep, since a new season invalidates every leaderboard.
 *
 * Backed by `season_state` rather than memory alone: a rollover that happens
 * while the process is down must still be seen as a rollover on the next boot,
 * because the season purge hangs off exactly that comparison.
 */
@Injectable()
export class SeasonService implements OnModuleInit {
  private readonly logger = new Logger(SeasonService.name);
  private readonly currentSeasons = new Map<Region, CachedSeason>();
  private readonly lastCompleted = new Map<Region, number>();
  /** Regions whose cached value came from disk and not yet from the API. */
  private readonly restored = new Set<Region>();

  constructor(
    private readonly pvpApi: PvpApi,
    private readonly state: SeasonStateRepository,
    private readonly events: SeasonEvents,
  ) {}

  /**
   * Rehydrates what was last observed, before any refresh runs. Without this
   * `previous` is undefined on a fresh process and the rollover branch below
   * can never be taken across a restart.
   */
  async onModuleInit(): Promise<void> {
    const stored = await this.state.loadAll();

    for (const entry of stored) {
      this.currentSeasons.set(entry.region, {
        id: entry.seasonId,
        name: entry.name,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        observedAt: entry.observedAt,
      });
      this.restored.add(entry.region);

      if (entry.lastCompletedSeasonId !== null) {
        this.lastCompleted.set(entry.region, entry.lastCompletedSeasonId);
      }
    }

    if (stored.length > 0) {
      this.logger.log(
        `Restored season state for ${stored.map((entry) => `${entry.region}:${entry.seasonId}`).join(', ')}`,
      );
    }
  }

  /** Fetches and caches the current season for a region. */
  async refresh(region: Region): Promise<number> {
    const index = await this.pvpApi.getSeasonIndex(region);
    const seasonId = index.current_season.id;
    const previous = this.currentSeasons.get(region);
    const acrossRestart = this.restored.delete(region);
    const lastCompletedId = index.last_completed_season?.id ?? null;

    if (lastCompletedId !== null) {
      this.lastCompleted.set(region, lastCompletedId);
    }

    // Blizzard writes `season_end_timestamp` onto the season's own record when
    // it ends, so the record stays worth re-reading for as long as no end date
    // has appeared. Once one has, nothing about it can change again.
    if (previous?.id === seasonId && previous.endsAt !== null) return seasonId;

    const season = await this.pvpApi.getSeason(region, seasonId);
    const observedAt = new Date();
    this.currentSeasons.set(region, {
      id: seasonId,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      observedAt,
    });

    await this.state.save({
      region,
      seasonId,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      lastCompletedSeasonId: this.lastCompleted.get(region) ?? null,
      observedAt,
    });

    this.announce(region, previous, seasonId, season.startsAt, season.endsAt, acrossRestart);

    return seasonId;
  }

  /** Logs the change and publishes it, so the purge does not have to poll. */
  private announce(
    region: Region,
    previous: CachedSeason | undefined,
    seasonId: number,
    startsAt: Date,
    endsAt: Date | null,
    acrossRestart: boolean,
  ): void {
    if (!previous) {
      this.logger.log(
        `Active season for ${region}: ${seasonId} (started ${startsAt.toISOString()})`,
      );
      return;
    }

    if (previous.id !== seasonId) {
      this.logger.warn(
        `Season rollover in ${region}: ${previous.id} replaced by ${seasonId} ` +
          `(started ${startsAt.toISOString()}${acrossRestart ? ', first seen after a restart' : ''})`,
      );
      this.events.emit({
        kind: 'rollover',
        region,
        seasonId,
        previousSeasonId: previous.id,
        at: startsAt,
        acrossRestart,
      });
      return;
    }

    // Same season, but an end date has just appeared on it.
    if (endsAt && !previous.endsAt) {
      this.logger.warn(`Season ${seasonId} has ended in ${region} at ${endsAt.toISOString()}`);
      this.events.emit({
        kind: 'ended',
        region,
        seasonId,
        previousSeasonId: seasonId,
        at: endsAt,
        acrossRestart,
      });
    }
  }

  /** Cached season id, or undefined if this region has not been refreshed yet. */
  getCurrentSeason(region: Region): number | undefined {
    return this.currentSeasons.get(region)?.id;
  }

  /** When the cached season began — the boundary for data worth keeping. */
  getSeasonStart(region: Region): Date | undefined {
    return this.currentSeasons.get(region)?.startsAt;
  }

  /** When the cached season ended, null if it is still running. */
  getSeasonEnd(region: Region): Date | null | undefined {
    return this.currentSeasons.get(region)?.endsAt;
  }

  /** Everything observed for a region, or undefined if it never has been. */
  getObserved(region: Region): CachedSeason | undefined {
    return this.currentSeasons.get(region);
  }

  /**
   * Whether the region's season has finished but no new one has started yet.
   * A region that has never been refreshed is not "ended" — it is unknown.
   */
  hasEnded(region: Region): boolean {
    const season = this.currentSeasons.get(region);

    return season !== undefined && season.endsAt !== null;
  }

  /** Everything known about each region's season, for the health endpoint. */
  describe(): Record<
    string,
    {
      id: number;
      name?: string;
      startsAt: string;
      endsAt: string | null;
      lastCompleted?: number;
      observedAt: string;
    }
  > {
    return Object.fromEntries(
      [...this.currentSeasons].map(([region, season]) => [
        region,
        {
          id: season.id,
          name: season.name,
          startsAt: season.startsAt.toISOString(),
          endsAt: season.endsAt?.toISOString() ?? null,
          lastCompleted: this.lastCompleted.get(region),
          observedAt: season.observedAt.toISOString(),
        },
      ]),
    );
  }
}
