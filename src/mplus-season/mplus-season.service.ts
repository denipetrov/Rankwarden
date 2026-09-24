import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RunLogger } from '../common/logging/run-context.js';
import type { Env } from '../config/env.schema.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type {
  MplusSeasonDocument,
  MplusSeasonStateDocument,
} from './entities/mplus-season.entity.js';
import { currentSeasonIn, endIn, startIn } from './mplus-catalogue.mapper.js';
import { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
import { MplusCatalogueService, type CatalogueRefresh } from './mplus-catalogue.service.js';
import { MplusSeasonEvents } from './mplus-season-events.service.js';
import { MplusSeasonStateRepository } from './mplus-season-state.repository.js';

/** The season current in one region, as the catalogue describes it there. */
export interface ResolvedMplusSeason {
  slug: string;
  name: string;
  /** Blizzard's M+ season id. Distinct from the PvP season id; reference only. */
  seasonId: number | null;
  expansionId: number;
  /** Dungeons the season lists, for reporting how complete a score is. */
  dungeons: number;
  /** When the season opened in this region. */
  startsAt: Date;
  /** When it ends in this region — Raider.io's 2030 placeholder while it runs. */
  endsAt: Date | null;
  /** Whether that end has passed. The season stays current until its successor opens. */
  ended: boolean;
}

/**
 * The season current in each region at `now`.
 *
 * A region with no catalogued season opened there is left out, and a caller
 * skips it rather than guessing.
 */
export function resolveRegions(
  seasons: readonly MplusSeasonDocument[],
  regions: readonly RaiderIoRegion[],
  now: Date,
): Map<RaiderIoRegion, ResolvedMplusSeason> {
  const resolution = new Map<RaiderIoRegion, ResolvedMplusSeason>();

  for (const region of regions) {
    const season = currentSeasonIn(seasons, region, now);
    const startsAt = season ? startIn(season, region) : null;
    if (!season || !startsAt) continue;

    const endsAt = endIn(season, region);

    resolution.set(region, {
      slug: season.slug,
      name: season.name,
      seasonId: season.blizzardSeasonId,
      expansionId: season.expansionId,
      dungeons: season.dungeonIds.length,
      startsAt,
      endsAt,
      ended: endsAt !== null && endsAt.getTime() <= now.getTime(),
    });
  }

  return resolution;
}

/**
 * Which Mythic+ season is current in each region, read from the season
 * catalogue rather than configured, and what changed since it was last looked at.
 *
 * The counterpart of `SeasonService`. The catalogue (`mplus_seasons`) already
 * holds every main season with its per-region start and end, so resolving the
 * current season costs a database read and no request; Raider.io is only asked
 * when the catalogue itself is due (`MplusCatalogueService`).
 *
 * What is observed is persisted in `mplus_season_state` and rehydrated at boot,
 * for the reason `season_state` exists: a rollover that happens while the
 * process is down must still read as a rollover on the next boot rather than as
 * a first observation.
 */
@Injectable()
export class MplusSeasonService implements OnModuleInit {
  private readonly logger = new RunLogger(MplusSeasonService.name);
  private readonly regions: RaiderIoRegion[];
  private readonly observed = new Map<RaiderIoRegion, MplusSeasonStateDocument>();
  /** Regions whose observed value came from disk and not yet from the catalogue. */
  private readonly restored = new Set<RaiderIoRegion>();

  constructor(
    config: ConfigService<Env, true>,
    private readonly catalogue: MplusCatalogueService,
    private readonly repository: MplusCatalogueRepository,
    private readonly state: MplusSeasonStateRepository,
    private readonly events: MplusSeasonEvents,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    const stored = await this.state.loadAll();

    for (const entry of stored) {
      this.observed.set(entry.region, entry);
      this.restored.add(entry.region);
    }

    if (stored.length > 0) {
      this.logger.log(
        `Restored Mythic+ season state for ` +
          stored.map((entry) => `${entry.region}:${entry.season}`).join(', '),
      );
    }
  }

  /**
   * Makes sure there is a catalogue to resolve a season from, reading Raider.io
   * when it is empty or past its TTL.
   *
   * Throws when the catalogue is still empty afterwards. A pass with no season
   * has nothing it can correctly fetch, and failing loudly beats fetching a
   * guessed one.
   */
  async ensureCatalogue(now = new Date()): Promise<CatalogueRefresh> {
    const refresh = await this.catalogue.refreshIfDue(now);

    if ((await this.repository.countSeasons()) === 0) {
      throw new Error(
        'The Mythic+ season catalogue is empty: Raider.io static data could not be read, ' +
          'so no current season can be resolved',
      );
    }

    return refresh;
  }

  /** The season current in each region at `now`, without recording anything. */
  async resolve(now = new Date()): Promise<Map<RaiderIoRegion, ResolvedMplusSeason>> {
    return resolveRegions(await this.repository.allSeasons(), this.regions, now);
  }

  /**
   * Resolves the current season in each region, records what changed, and
   * announces a season ending or rolling over.
   *
   * Called by the season check on its own interval and by every live pass, so a
   * transition is noticed whichever runs first — and by a pass even when the
   * check is switched off.
   */
  async observe(now = new Date()): Promise<Map<RaiderIoRegion, ResolvedMplusSeason>> {
    const resolution = await this.resolve(now);

    for (const [region, season] of resolution) {
      const previous = this.observed.get(region);
      const acrossRestart = this.restored.delete(region);
      const next: MplusSeasonStateDocument = {
        region,
        season: season.slug,
        name: season.name,
        startsAt: season.startsAt,
        endsAt: season.endsAt,
        ended: season.ended,
        observedAt: now,
      };

      if (previous && isSameObservation(previous, next)) continue;

      this.observed.set(region, next);
      await this.state.save(next);
      this.announce(previous, next, acrossRestart);
    }

    return resolution;
  }

  /** Logs the change and publishes it, so the purge does not have to poll. */
  private announce(
    previous: MplusSeasonStateDocument | undefined,
    next: MplusSeasonStateDocument,
    acrossRestart: boolean,
  ): void {
    const { region } = next;

    if (!previous) {
      this.logger.log(
        `Active Mythic+ season for ${region}: ${next.season} ` +
          `(started ${next.startsAt.toISOString()}${next.ended ? ', already ended' : ''})`,
      );
      return;
    }

    if (previous.season !== next.season) {
      this.logger.warn(
        `Mythic+ season rollover in ${region}: ${previous.season} replaced by ${next.season} ` +
          `(started ${next.startsAt.toISOString()}${acrossRestart ? ', first seen after a restart' : ''})`,
      );
      this.events.emit({
        kind: 'rollover',
        region,
        season: next.season,
        previousSeason: previous.season,
        at: next.startsAt,
        acrossRestart,
      });
      return;
    }

    if (next.ended && !previous.ended) {
      this.logger.warn(
        `Mythic+ season ${next.season} has ended in ${region} at ${next.endsAt?.toISOString()}`,
      );
      this.events.emit({
        kind: 'ended',
        region,
        season: next.season,
        previousSeason: next.season,
        at: next.endsAt ?? next.observedAt,
        acrossRestart,
      });
      return;
    }

    // Same season, not ended: Raider.io has moved a date — typically the 2030
    // placeholder replaced by the real end, days before the season closes.
    this.logger.log(
      `Mythic+ season ${next.season} in ${region} now ends ${next.endsAt?.toISOString() ?? 'unknown'}`,
    );
  }

  /** Everything observed for a region, or undefined if it never has been. */
  getObserved(region: RaiderIoRegion): MplusSeasonStateDocument | undefined {
    return this.observed.get(region);
  }

  /** What was last observed in each region, for the health endpoint. From memory. */
  describe(): Record<
    string,
    {
      season: string;
      name: string;
      startsAt: string;
      endsAt: string | null;
      ended: boolean;
      observedAt: string;
    }
  > {
    return Object.fromEntries(
      [...this.observed].map(([region, entry]) => [
        region,
        {
          season: entry.season,
          name: entry.name,
          startsAt: entry.startsAt.toISOString(),
          endsAt: entry.endsAt?.toISOString() ?? null,
          ended: entry.ended,
          observedAt: entry.observedAt.toISOString(),
        },
      ]),
    );
  }
}

/** Whether anything worth recording or announcing differs. `observedAt` does not count. */
function isSameObservation(
  left: MplusSeasonStateDocument,
  right: MplusSeasonStateDocument,
): boolean {
  return (
    left.season === right.season &&
    left.ended === right.ended &&
    left.startsAt.getTime() === right.startsAt.getTime() &&
    (left.endsAt?.getTime() ?? null) === (right.endsAt?.getTime() ?? null)
  );
}
