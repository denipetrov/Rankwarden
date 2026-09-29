import type { MplusSeasonDocument } from '../mplus-season/entities/mplus-season.entity.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';

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
 * The configured regions a season's archive does not yet hold in full.
 *
 * Every region, for a season never tried or for one archived by the earlier
 * `world` reader, whose marker has no `regions`. A region added to
 * `RAIDERIO_REGIONS` later is owed too, so it is filled in without refetching
 * the regions already held.
 */
export function regionsOwed(
  season: Pick<MplusSeasonDocument, 'archive'>,
  regions: readonly RaiderIoRegion[],
): RaiderIoRegion[] {
  return regions.filter((region) => season.archive?.regions?.[region]?.status !== 'complete');
}

/**
 * Whether the archive holds a season in every configured region — the one rule
 * every reader of "is it archived?" uses, so they cannot disagree.
 *
 * Judged over the configured regions, not the marker's stored status: a region
 * dropped from `RAIDERIO_REGIONS` leaves a marker that still says `incomplete`,
 * and nothing rewrites it. Not `unarchivable`: such a season has no archived
 * runs, and stays with whatever the live board last showed.
 */
export function isArchivedEverywhere(
  season: Pick<MplusSeasonDocument, 'archive'>,
  regions: readonly RaiderIoRegion[],
): boolean {
  return (
    season.archive !== undefined &&
    season.archive.status !== 'unarchivable' &&
    regionsOwed(season, regions).length === 0
  );
}

/**
 * The seasons the archive still owes, newest first.
 *
 * Newest first as the PvP archive does: recent history is what a reader is
 * likeliest to ask for, and a backlog interrupted partway should have spent
 * its effort there. It is also what makes a season that has just ended the
 * next one archived, which the live season transition is waiting on.
 *
 * A season is owed while any configured region is (`regionsOwed`), so
 * `incomplete` and `partial` seasons come back and `unarchivable` ones never
 * do — except for seasons named in `skip`, which is how one that keeps failing
 * is set aside for the rest of a tick rather than retried in a loop.
 *
 * No main-season filter here: the catalogue holds nothing else.
 */
export function pendingSeasons(
  seasons: readonly MplusSeasonDocument[],
  options: { now: Date; regions: readonly RaiderIoRegion[]; skip?: ReadonlySet<string> },
): MplusSeasonDocument[] {
  return seasons
    .filter((season) => isFinished(season, options.now))
    .filter((season) => season.archive?.status !== 'unarchivable')
    .filter((season) => regionsOwed(season, options.regions).length > 0)
    .filter((season) => !options.skip?.has(season.slug))
    .sort((left, right) => latestEnd(right) - latestEnd(left));
}

function latestEnd(season: Pick<MplusSeasonDocument, 'ends'>): number {
  return Math.max(0, ...Object.values(season.ends).map((end) => end.getTime()));
}
