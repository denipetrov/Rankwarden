import type { MplusSeasonDocument } from '../mplus-season/entities/mplus-season.entity.js';

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
 * its effort there. It is also what makes a season that has just ended the
 * next one archived, which the live season transition is waiting on.
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
