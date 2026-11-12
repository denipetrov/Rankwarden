import type { Collection, Filter } from 'mongodb';

import type { MplusCharacterDocument } from './entities/mplus-character.entity.js';

/**
 * Whether a character's stored runs cover every dungeon its season lists.
 *
 * The leaderboard is read as one board across all dungeons, so a character can
 * appear in it for some dungeons and miss the others: their runs there sit
 * below the window. `mythicScore` is then a partial sum, and the flag is how a
 * reader keeps to the characters whose score is the whole of it.
 *
 * A season whose dungeon list is unknown (0) covers no one: claiming a
 * character complete against a list nobody has read would be a guess.
 */
export function isFullyCovered(dungeonsCovered: number, seasonDungeons: number): boolean {
  return seasonDungeons > 0 && dungeonsCovered >= seasonDungeons;
}

/**
 * Re-derives `isFullyCovered` for a season's stored characters wherever it is
 * missing or disagrees with `dungeonsCovered`.
 *
 * Every write sets the flag, so on a settled database this matches nothing.
 * It exists for what a write does not reach: characters written before the
 * flag did, an archive that is never rewritten, and a live character a pass
 * did not see — which keeps its runs and would otherwise keep a flag computed
 * against a dungeon list the catalogue has since corrected.
 */
export async function refreshCoverage(
  collection: Collection<MplusCharacterDocument>,
  season: string,
  seasonDungeons: number,
): Promise<number> {
  // `$literal`, because a bare `false` in a pipeline `$set` can read as a
  // projection flag rather than a value.
  const covered =
    seasonDungeons > 0 ? { $gte: ['$dungeonsCovered', seasonDungeons] } : { $literal: false };

  const result = await collection.updateMany(
    {
      season,
      $expr: { $ne: [{ $ifNull: ['$isFullyCovered', null] }, covered] },
    } as Filter<MplusCharacterDocument>,
    [{ $set: { isFullyCovered: covered } }],
  );

  return result.modifiedCount;
}
