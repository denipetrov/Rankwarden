import type { StaticDungeon, StaticSeason } from '../raiderio/schemas/static-data.schema.js';
import type { MplusDungeonDocument, MplusSeasonDocument } from './entities/mplus-season.entity.js';

/** Parses a region-keyed timestamp map, dropping anything that is not a date. */
function toDates(values: Record<string, string> | undefined): Record<string, Date> {
  const dates: Record<string, Date> = {};

  for (const [region, value] of Object.entries(values ?? {})) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) dates[region] = new Date(at);
  }

  return dates;
}

/**
 * The seasons worth cataloguing: main seasons only.
 *
 * Absent `is_main_season` counts as main. Every season observed carries the
 * flag, and reading a missing one as "side event" would silently drop a real
 * season from the catalogue, and so from the live pass and the archive.
 */
export function mainSeasonsOf(seasons: readonly StaticSeason[]): StaticSeason[] {
  return seasons.filter((season) => season.is_main_season !== false);
}

/**
 * A static-data season as the catalogue stores it — every field except the
 * archive marker, which only the archive writes.
 */
export function toSeasonDocument(
  season: StaticSeason,
  expansionId: number,
  catalogueUpdatedAt: Date,
): Omit<MplusSeasonDocument, 'archive'> {
  return {
    slug: season.slug,
    name: season.name,
    shortName: season.short_name ?? null,
    expansionId,
    blizzardSeasonId: season.blizzard_season_id ?? null,
    starts: toDates(season.starts),
    ends: toDates(season.ends),
    dungeonIds: (season.dungeons ?? []).map((dungeon) => dungeon.id),
    catalogueUpdatedAt,
  };
}

/** A dungeon as the catalogue stores it, minus the expansions it grows over time. */
export function toDungeonDocument(
  dungeon: StaticDungeon,
  updatedAt: Date,
): Omit<MplusDungeonDocument, 'expansionIds'> {
  return {
    id: dungeon.id,
    slug: dungeon.slug,
    name: dungeon.name,
    shortName: dungeon.short_name ?? null,
    challengeModeId: dungeon.challenge_mode_id ?? null,
    keystoneTimerSeconds: dungeon.keystone_timer_seconds ?? null,
    iconUrl: dungeon.icon_url ?? null,
    backgroundImageUrl: dungeon.background_image_url ?? null,
    updatedAt,
  };
}

/**
 * Every distinct dungeon in an expansion's seasons.
 *
 * Deduplicated by id within the call, because one expansion lists the same
 * dungeon in each of its seasons — Legion lists all thirteen six times.
 */
export function dungeonsOf(seasons: readonly StaticSeason[]): StaticDungeon[] {
  const byId = new Map<number, StaticDungeon>();

  for (const season of seasons) {
    for (const dungeon of season.dungeons ?? []) byId.set(dungeon.id, dungeon);
  }

  return [...byId.values()];
}

/**
 * When a season opened in a region.
 *
 * A region the season lists no start for takes the season's earliest start.
 * Absent is not "never": refusing to ingest a region because its timestamp is
 * missing would silently drop it, which is the rule the region filter has
 * always followed. A season with no parseable start anywhere has no start at
 * all, and so can never be current.
 */
export function startIn(season: Pick<MplusSeasonDocument, 'starts'>, region: string): Date | null {
  const own = season.starts[region];
  if (own) return own;

  const times = Object.values(season.starts).map((start) => start.getTime());

  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/** When a season ends in a region, or null when the catalogue does not say. */
export function endIn(season: Pick<MplusSeasonDocument, 'ends'>, region: string): Date | null {
  return season.ends[region] ?? null;
}

/**
 * The season current in one region: the catalogued season that most recently
 * opened there.
 *
 * Per region, not global, because regions stagger by up to 32 hours. On the day
 * a season rolls, the US is on the new season while Europe is still on the old
 * one — and the old one stays current in Europe, ended or not, until the new
 * one opens there. That is the PvP rule too (§4.8): a finished season stays
 * live and readable until its successor actually starts.
 *
 * Decided on start dates, never on list order or on end dates. Raider.io lists
 * a running season with a `2030-01-01` placeholder end, and replaces it only
 * once the season is over, so an end date cannot say which season is running.
 *
 * Every catalogued season is a main season, so a side event cannot be picked.
 */
export function currentSeasonIn<
  T extends Pick<MplusSeasonDocument, 'slug' | 'starts' | 'expansionId'>,
>(seasons: readonly T[], region: string, now: Date): T | null {
  let best: { season: T; startedAt: number } | null = null;

  for (const season of seasons) {
    const startedAt = startIn(season, region)?.getTime();
    if (startedAt === undefined || startedAt > now.getTime()) continue;

    // Ties broken by expansion, then slug, so the answer never depends on the
    // order the database happened to return.
    if (
      !best ||
      startedAt > best.startedAt ||
      (startedAt === best.startedAt &&
        (season.expansionId > best.season.expansionId ||
          (season.expansionId === best.season.expansionId && season.slug > best.season.slug)))
    ) {
      best = { season, startedAt };
    }
  }

  return best?.season ?? null;
}

/**
 * Whether a season's archive is settled for one region: that region held in
 * full, or the whole season refused for good.
 *
 * Per region, because the archive reads each region's own board: a region can
 * be retired from the live collections as soon as its own share is archived,
 * whatever the others are doing.
 *
 * `unarchivable` counts, as the PvP interlock counts a season Blizzard stopped
 * serving: the archive will never hold it, and waiting for it would keep the
 * live season in place forever rather than protect anything.
 */
export function isArchiveSettled(
  season: Pick<MplusSeasonDocument, 'archive'>,
  region: string,
): boolean {
  if (season.archive?.status === 'unarchivable') return true;

  const regions: Partial<Record<string, { status: string }>> = season.archive?.regions ?? {};

  return regions[region]?.status === 'complete';
}
