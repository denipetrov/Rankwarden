import type { IndexDescription } from 'mongodb';

/** Indexes on `characters`. */
export const CHARACTERS_INDEXES: IndexDescription[] = [
  { key: { seasonId: 1, region: 1, characterId: 1 }, name: 'character_identity', unique: true },
  { key: { characterName: 1, realmSlug: 1 }, name: 'character_lookup' },
  // One compound wildcard index serves ordered queries for every bracket:
  //   find({ seasonId, region, 'ratings.3v3': { $gt: 0 } }).sort({ 'ratings.3v3': -1 })
  // Measured index-ordered (no blocking sort) and 4.6x smaller than the five
  // per-bracket indexes it replaces — which could never have reached 85 anyway.
  { key: { seasonId: 1, region: 1, 'ratings.$**': 1 }, name: 'bracket_ratings' },
  // Enrichment selects the least recently fetched characters first;
  // never-enriched ones sort ahead of everything because the field is absent.
  // Led by the type because characters that are never enriched never get a
  // timestamp either: without the prefix they would sit at the very front
  // of the timestamp order, and every run would walk past all of them
  // before reaching the first character it can use.
  { key: { characterType: 1, specsFetchedAt: 1 }, name: 'enrichment_specs_staleness' },
  { key: { characterType: 1, profileFetchedAt: 1 }, name: 'enrichment_profile_staleness' },
];

/**
 * Indexes on `characters` an earlier build created and a later one replaced:
 * the staleness indexes from before they were led by `characterType`. Dropped
 * at boot, after their replacements exist.
 */
export const SUPERSEDED_CHARACTERS_INDEXES: ReadonlySet<string> = new Set([
  'specs_staleness',
  'profile_staleness',
]);

/**
 * Names of the per-bracket indexes the earliest builds created on `characters`,
 * one for every bracket, all superseded by `bracket_ratings`. A pattern rather
 * than a list, because there was one per bracket. Dropped at boot.
 */
export const LEGACY_CHARACTERS_INDEX_PATTERN = /^bracket_.+_rank$|^best_in_family$/;

/** Indexes on every `<family>_ratings` collection; each family gets the same set. */
export const RATING_INDEXES: IndexDescription[] = [
  // The board itself: a sorted range scan across every spec at once.
  { key: { seasonId: 1, region: 1, rating: -1 }, name: 'board_order' },
  {
    key: { seasonId: 1, region: 1, bracket: 1, characterId: 1 },
    name: 'entry_identity',
    unique: true,
  },
  // "Every rating this character holds", for a character page.
  { key: { characterId: 1 }, name: 'character' },
];
