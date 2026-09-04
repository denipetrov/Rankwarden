import type { Bracket, Region, SpecSplitFamily } from '../../blizzard/blizzard.constants.js';

/**
 * One rating, in one spec-specific bracket, for one character.
 *
 * Deliberately flat and narrow: this is an ordering index, not a record of the
 * character. A "all classes, all specs" board is a single sorted range scan over
 * it, and a character legitimately appears once per spec they have played. The
 * display data is joined from `characters` by `characterId` afterwards.
 */
export interface SpecRatingDocument {
  seasonId: number;
  region: Region;
  /** e.g. "shuffle-mage-fire" — encodes class and spec. */
  bracket: Bracket;
  characterId: number;
  rating: number;
  fetchedAt: Date;
}

/** One collection per family, so each board is its own sorted range. */
export const SPEC_RATING_COLLECTIONS: Record<SpecSplitFamily, string> = {
  shuffle: 'shuffle_ratings',
  blitz: 'blitz_ratings',
};
