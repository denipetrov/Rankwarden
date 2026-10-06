import type { IndexDescription } from 'mongodb';

/** Indexes on `archive_entries`. */
export const ARCHIVE_ENTRIES_INDEXES: IndexDescription[] = [
  // A past season's ladder, ordered.
  { key: { seasonId: 1, region: 1, bracket: 1, rating: -1 }, name: 'archive_board' },
  // Idempotent re-runs: archiving a season twice must not duplicate it.
  {
    key: { seasonId: 1, region: 1, bracket: 1, characterId: 1 },
    name: 'archive_identity',
    unique: true,
  },
  // One character's history across seasons.
  { key: { characterId: 1, seasonId: -1 }, name: 'archive_character' },
];

/** Indexes on `archive_seasons`. */
export const ARCHIVE_SEASONS_INDEXES: IndexDescription[] = [
  { key: { seasonId: 1, region: 1 }, name: 'season_identity', unique: true },
];

/** Indexes on `archive_brackets`. */
export const ARCHIVE_BRACKETS_INDEXES: IndexDescription[] = [
  { key: { seasonId: 1, region: 1, bracket: 1 }, name: 'bracket_identity', unique: true },
];
