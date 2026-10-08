import type { Bracket, Region } from '../../blizzard/blizzard.constants.js';

/**
 * One rating, in one bracket, for one character.
 *
 * Deliberately flat and narrow: this is an ordering index, not a record of the
 * character. A board is a single sorted range scan over one of these
 * collections, and in shuffle and blitz a character legitimately appears once
 * per spec they have played. Display data is joined from `characters` by
 * `characterId` afterwards.
 */
export interface RatingDocument {
  seasonId: number;
  region: Region;
  /** e.g. "3v3", or "shuffle-mage-fire" which also encodes class and spec. */
  bracket: Bracket;
  characterId: number;
  rating: number;
  fetchedAt: Date;
}
