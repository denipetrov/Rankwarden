import type { StaticDungeon, StaticSeason } from '../raiderio/schemas/static-data.schema.js';
import type { MplusDungeonDocument, MplusSeasonDocument } from './entities/mplus-archive.entity.js';

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
 * season from the catalogue and so from the archive.
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
 * Whether a season has ended in every region it lists.
 *
 * Every region, not the first: regions stagger by up to 32 hours, and
 * archiving the moment the first region closed would freeze a board the other
 * regions were still adding runs to — for good, since an archived season is
 * never read again.
 *
 * A season with no end dates at all is not finished. That is how a malformed
 * payload has to read: guessing "finished" would archive a live season once
 * and never correct it.
 */
export function isFinished(season: Pick<MplusSeasonDocument, 'ends'>, now: Date): boolean {
  const ends = Object.values(season.ends);
  if (ends.length === 0) return false;

  return ends.every((end) => end.getTime() <= now.getTime());
}

/**
 * The seasons the archive still owes, newest first.
 *
 * Newest first as the PvP archive does: recent history is what a reader is
 * likeliest to ask for, and a backlog interrupted partway should have spent
 * its effort there.
 *
 * `complete` and `unarchivable` are settled and never returned. `incomplete`
 * is, so a season with a failed page is retried — except for seasons named in
 * `skip`, which is how one that keeps failing is set aside for the rest of a
 * tick rather than retried in a loop.
 *
 * No main-season filter here: the catalogue holds nothing else.
 */
export function pendingSeasons(
  seasons: readonly MplusSeasonDocument[],
  options: { now: Date; skip?: ReadonlySet<string> },
): MplusSeasonDocument[] {
  return seasons
    .filter((season) => isFinished(season, options.now))
    .filter((season) => season.archive?.status !== 'complete')
    .filter((season) => season.archive?.status !== 'unarchivable')
    .filter((season) => !options.skip?.has(season.slug))
    .sort((left, right) => latestEnd(right) - latestEnd(left));
}

function latestEnd(season: Pick<MplusSeasonDocument, 'ends'>): number {
  return Math.max(0, ...Object.values(season.ends).map((end) => end.getTime()));
}
