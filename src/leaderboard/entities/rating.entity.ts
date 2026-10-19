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
  /**
   * Class and spec as Blizzard's ladder names spell them — `deathknight`,
   * `beastmastery` — so a board can be filtered to one class, or one class and
   * spec (a spec name alone is ambiguous: Holy is a paladin and a priest spec).
   *
   * On shuffle and blitz rows they come from the bracket name and are always
   * set. On 2v2, 3v3 and rbg rows they come from the character's enriched
   * profile, which is the character's *active* spec rather than necessarily
   * the one played on that ladder; null until the character is enriched.
   */
  class: string | null;
  spec: string | null;
  rating: number;
  fetchedAt: Date;
}
