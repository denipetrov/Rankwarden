import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import { CURRENT_EXPANSION_ID, type RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type { StaticSeason } from '../raiderio/schemas/static-data.schema.js';

export interface ResolvedMplusSeason {
  slug: string;
  name: string;
  /** Blizzard's M+ season id. Distinct from the PvP season id; reference only. */
  seasonId: number | null;
  /** Dungeons the season publishes, for reporting how complete a score is. */
  dungeons: number;
  /** Per-region start, when the payload carried one. */
  startsAt: Record<string, string>;
}

/**
 * Which M+ season to ingest, resolved from Raider.io rather than configured.
 *
 * `RAIDERIO_SEASON` can pin one — useful for a rehearsal, or to keep ingesting
 * a season through a rollover — but it is empty by default. Left to
 * configuration a season slug is a landmine: the moment the season rolls, the
 * service goes on fetching a frozen ladder and the new one is never ingested,
 * with every log line reporting success.
 *
 * The result is cached for `RAIDERIO_SEASON_TTL_MS`, so the season costs one
 * request a day rather than one per pass.
 */
@Injectable()
export class MplusSeasonService {
  private readonly logger = new Logger(MplusSeasonService.name);
  private readonly pinned: string;
  private readonly ttlMs: number;
  private cached: { at: number; season: ResolvedMplusSeason } | null = null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: MythicPlusApi,
  ) {
    this.pinned = config.get('RAIDERIO_SEASON', { infer: true });
    this.ttlMs = config.get('RAIDERIO_SEASON_TTL_MS', { infer: true });
  }

  /** The season in progress, from cache when it is fresh enough. */
  async current(now = Date.now()): Promise<ResolvedMplusSeason> {
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.season;

    const seasons = await this.api.getSeasons(CURRENT_EXPANSION_ID);
    const pinned = this.pinned
      ? seasons.find((candidate) => candidate.slug === this.pinned)
      : undefined;
    const season = this.pinned
      ? pinned
        ? describe(pinned)
        : pinnedFallback(this.pinned)
      : pickCurrent(seasons, new Date(now));

    if (!season) {
      throw new Error(
        `Raider.io published no current Mythic+ season for expansion ${CURRENT_EXPANSION_ID}`,
      );
    }

    if (this.cached && this.cached.season.slug !== season.slug) {
      this.logger.warn(`Mythic+ season rolled over: ${this.cached.season.slug} -> ${season.slug}`);
    }

    this.cached = { at: now, season };
    this.logger.log(`Mythic+ season resolved to ${season.slug} (${season.dungeons} dungeons)`);

    return season;
  }

  /** The last resolved season without fetching, for reporting. */
  get lastResolved(): ResolvedMplusSeason | null {
    return this.cached?.season ?? null;
  }

  /** Forgets the cache, so the next call re-reads. Used by the admin trigger. */
  invalidate(): void {
    this.cached = null;
  }
}

/**
 * The newest main season already started somewhere.
 *
 * `is_main_season` is what excludes side events: `season-mn-1-break-the-meta`
 * ran for a week inside season 1 with its own slug and its own leaderboard, and
 * picking it would have swapped the ladder out for a week and swapped it back.
 *
 * "Started somewhere" rather than "started everywhere" because regions stagger
 * by up to 32 hours, and the runs endpoint serves a region as soon as that
 * region opens — the same staggering the PvP season transition allows for.
 */
export function pickCurrent(seasons: StaticSeason[], now: Date): ResolvedMplusSeason | null {
  const started = seasons
    .filter((season) => season.is_main_season !== false)
    .map((season) => ({ season, startedAt: earliestStart(season) }))
    .filter(({ startedAt }) => startedAt !== null && startedAt <= now.getTime())
    .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));

  // Raider.io lists newest first, so an unparseable set of timestamps still
  // leaves the first main season as the best available answer.
  const chosen =
    started[0]?.season ?? seasons.find((season) => season.is_main_season !== false) ?? null;

  return chosen ? describe(chosen) : null;
}

function earliestStart(season: StaticSeason): number | null {
  const times = Object.values(season.starts ?? {})
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));

  return times.length > 0 ? Math.min(...times) : null;
}

function describe(season: StaticSeason): ResolvedMplusSeason {
  return {
    slug: season.slug,
    name: season.name,
    seasonId: season.blizzard_season_id ?? null,
    dungeons: season.dungeons?.length ?? 0,
    startsAt: season.starts ?? {},
  };
}

/**
 * A pinned slug Raider.io does not list is still honoured.
 *
 * The pin exists to override what the API says, so refusing to use it because
 * the API disagrees would defeat it. The runs endpoint answers for the slug or
 * it does not, and that is the real test.
 */
function pinnedFallback(slug: string): ResolvedMplusSeason {
  return { slug, name: slug, seasonId: null, dungeons: 0, startsAt: {} };
}

/** Regions a resolved season has opened in, for a caller that wants to skip the rest. */
export function openRegions(
  season: ResolvedMplusSeason,
  regions: readonly RaiderIoRegion[],
  now: Date,
): RaiderIoRegion[] {
  return regions.filter((region) => {
    const starts = season.startsAt[region];
    if (!starts) return true;

    const at = Date.parse(starts);

    return !Number.isFinite(at) || at <= now.getTime();
  });
}
